// ============================================================
//  Dewan Foundation First-Time Funding Inquiry — Middleware v1
//
//  Replaces the Google Form at dewanfoundation.org/funding-inquiries
//  (previously wrote to a Google Sheet) — writes directly to
//  Salesforce instead.
//
//  GET  /accounts?zip=XXXXX   → Query SF Accounts by ZIP (dedupe check)
//  GET  /accounts?name=XXXXX  → Query SF Accounts by Name (dedupe check)
//  POST /submit                → Write inquiry data to Salesforce:
//                                 Account (reused if the EIN already exists),
//                                 Contact, and a new Funding Request
//
//  Config (Heroku Config Vars):
//    SF_CLIENT_ID           Consumer Key  (External Client App)
//    SF_CLIENT_SECRET       Consumer Secret
//    SF_LOGIN_URL           https://thejohnandsusandewanfoundation.my.salesforce.com
//    SF_OBJECT              Salesforce object API name   (default: Account)
//    SF_ACCOUNT_RECORD_TYPE DeveloperName of the Account Record Type to use
//                           for new inquiry Accounts (default: Organization).
//                           Without this, new Accounts get created under
//                           whatever the org's default Account Record Type
//                           is — in an NPSP org that's typically "Household
//                           Account", and NPSP automation then overwrites
//                           Type back to "Household" regardless of what
//                           this middleware sends, even though we explicitly
//                           set Type: 'Nonprofit' below.
//    SF_FUNDING_REQUEST_OBJECT  API name of the Funding Request object
//                           (default: outfunds__Funding_Request__c)
//    SF_FUNDING_PROGRAM_OBJECT  API name of the Funding Program object
//                           (default: outfunds__Funding_Program__c)
//    SF_FUNDING_PROGRAM_NAME    Name of the Funding Program every new
//                           inquiry is linked to (default: New Funding Requests)
// ============================================================

const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const app     = express();

app.use(express.json({ limit: '50mb' }));
app.use(cors());

// ── CONFIG ────────────────────────────────────────────────────
const SF_CLIENT_ID      = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET  = process.env.SF_CLIENT_SECRET;
const SF_LOGIN_URL      = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
const SF_OBJECT         = process.env.SF_OBJECT || 'Account';
const SF_ACCOUNT_RECORD_TYPE = process.env.SF_ACCOUNT_RECORD_TYPE || 'Organization';
const SF_FUNDING_REQUEST_OBJECT = process.env.SF_FUNDING_REQUEST_OBJECT || 'outfunds__Funding_Request__c';
const SF_FUNDING_PROGRAM_OBJECT = process.env.SF_FUNDING_PROGRAM_OBJECT || 'outfunds__Funding_Program__c';
const SF_FUNDING_PROGRAM_NAME   = process.env.SF_FUNDING_PROGRAM_NAME   || 'New Funding Requests';
const PORT              = process.env.PORT || 3000;

// ── INPUT VALIDATION HELPERS ─────────────────────────────────
// Salesforce record IDs are 15 or 18 alphanumeric characters.
function isValidSfId(id) {
  return /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(id || '');
}

function isValidZip(zip) {
  return /^\d{5}$/.test(zip || '');
}

// ── TOKEN CACHE ───────────────────────────────────────────────
// Reuse access token until ~5 min before expiry (~2hr window)
let _token = null;
let _tokenExpiry = 0;

async function getSFToken() {
  const now = Date.now();
  if (_token && now < _tokenExpiry) return _token;

  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
  });
  const res = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Salesforce auth failed: ${err}`);
  }
  const data = await res.json();
  _token = data;
  _tokenExpiry = now + (110 * 60 * 1000); // cache for 110 min
  return _token;
}

// ── ACCOUNT RECORD TYPE CACHE ─────────────────────────────────
// Looked up once by DeveloperName and cached for the life of the
// dyno, same idea as the token cache above. If SF_ACCOUNT_RECORD_TYPE
// doesn't match any active Account Record Type, we log a warning and
// fall back to leaving RecordTypeId unset (old behavior) rather than
// failing every submission.
let _recordTypeId = null;
let _recordTypeChecked = false;

async function getAccountRecordTypeId(instanceUrl, accessToken) {
  if (_recordTypeChecked) return _recordTypeId;
  _recordTypeChecked = true;

  try {
    const soql = `
      SELECT Id FROM RecordType
      WHERE SObjectType = 'Account'
      AND DeveloperName = '${SF_ACCOUNT_RECORD_TYPE.replace(/'/g, "\\'")}'
      AND IsActive = true
      LIMIT 1
    `.trim();
    const records = await sfQuery(instanceUrl, accessToken, soql);
    if (records.length) {
      _recordTypeId = records[0].Id;
    } else {
      console.warn(`No active Account Record Type found with DeveloperName "${SF_ACCOUNT_RECORD_TYPE}" — new Accounts will be created without an explicit RecordTypeId (org default will apply).`);
    }
  } catch (err) {
    console.warn(`Account Record Type lookup failed: ${err.message} — proceeding without RecordTypeId.`);
  }
  return _recordTypeId;
}

// ── SOQL / VALUE HELPERS ──────────────────────────────────────
function escSoql(v) {
  return String(v || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// "$25,000" / "25000.50" -> 25000.5. Returns null when empty or not a
// positive number.
function parseAmount(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

// YYYY-MM-DD in the Foundation's time zone (Salesforce Date field).
function todayCentral() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

// Funding Request Name is Text(80): "<Org name> - Funding Inquiry - YYYY-MM-DD"
function buildFundingRequestName(orgName, dateStr) {
  const suffix = ` - Funding Inquiry - ${dateStr}`;
  const base = (orgName || 'Unnamed Organization').trim();
  const room = 80 - suffix.length;
  return (base.length > room ? base.slice(0, room - 1).trimEnd() + '…' : base) + suffix;
}

// ── DEDUPE: EXISTING ACCOUNT / CONTACT ────────────────────────
// EIN_Number__c is unique on Account, so an EIN match is a reliable
// "this organization is already in Salesforce" signal.
async function findAccountIdByEin(instanceUrl, accessToken, ein) {
  if (!ein) return null;
  const records = await sfQuery(instanceUrl, accessToken,
    `SELECT Id FROM Account WHERE EIN_Number__c = '${escSoql(ein)}' AND IsDeleted = false LIMIT 1`);
  return records.length ? records[0].Id : null;
}

async function findContactIdByEmail(instanceUrl, accessToken, accountId, email) {
  if (!email) return null;
  const records = await sfQuery(instanceUrl, accessToken,
    `SELECT Id FROM Contact WHERE AccountId = '${escSoql(accountId)}' AND Email = '${escSoql(email)}' AND IsDeleted = false LIMIT 1`);
  return records.length ? records[0].Id : null;
}

// ── FUNDING PROGRAM CACHE ─────────────────────────────────────
// Looked up by Name. Only cached when found, so fixing the name (or
// creating the program) takes effect without a restart.
let _fundingProgramId = null;

async function getFundingProgramId(instanceUrl, accessToken) {
  if (_fundingProgramId) return _fundingProgramId;
  try {
    const records = await sfQuery(instanceUrl, accessToken,
      `SELECT Id FROM ${SF_FUNDING_PROGRAM_OBJECT} WHERE Name = '${escSoql(SF_FUNDING_PROGRAM_NAME)}' LIMIT 1`);
    if (records.length) {
      _fundingProgramId = records[0].Id;
    } else {
      console.warn(`No Funding Program named "${SF_FUNDING_PROGRAM_NAME}" — Funding Requests will be created without a Funding Program.`);
    }
  } catch (err) {
    console.warn(`Funding Program lookup failed: ${err.message} — proceeding without a Funding Program.`);
  }
  return _fundingProgramId;
}

// ── SF SOQL QUERY HELPER ──────────────────────────────────────
async function sfQuery(instanceUrl, accessToken, soql) {
  const encoded = encodeURIComponent(soql);
  const res = await fetch(
    `${instanceUrl}/services/data/v59.0/query?q=${encoded}`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  const body = await res.json();
  if (!res.ok) throw new Error(`SF Query failed: ${JSON.stringify(body)}`);
  return body.records;
}

// ── SF REST HELPERS ───────────────────────────────────────────
// Attaches the parsed Salesforce error array to the thrown Error (as
// `.sfErrors`) so callers can inspect specific errorCodes/messages —
// e.g. to turn a DUPLICATE_VALUE on EIN_Number__c into a friendly
// message — rather than just having the raw JSON string.
function sfError(prefix, object, body) {
  const err = new Error(`${prefix} ${object} failed: ${JSON.stringify(body)}`);
  err.sfErrors = Array.isArray(body) ? body : [body];
  return err;
}

async function sfPost(instanceUrl, token, object, data) {
  const res = await fetch(
    `${instanceUrl}/services/data/v59.0/sobjects/${object}/`,
    {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    }
  );
  const body = await res.json();
  if (!res.ok) throw sfError('SF POST', object, body);
  return body;
}

async function sfPatch(instanceUrl, token, object, id, data) {
  const res = await fetch(
    `${instanceUrl}/services/data/v59.0/sobjects/${object}/${id}`,
    {
      method:  'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    }
  );
  if (res.status === 204) return { success: true };
  const body = await res.json();
  if (!res.ok) throw sfError('SF PATCH', object, body);
  return body;
}

// ── SUBMISSION ID ─────────────────────────────────────────────
function generateSubmissionId() {
  const now  = new Date();
  const pad  = n => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
  const rand = Math.random().toString(36).substr(2, 6).toUpperCase();
  return `FI-${date}-${rand}`;
}

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:   'ok',
    service:  'Dewan Foundation Funding Inquiry Middleware',
    version:  '1.1',
    object:   SF_OBJECT,
    endpoints: [
      'GET  /accounts?zip=XXXXX',
      'GET  /accounts?name=XXXXX',
      'POST /submit',
    ]
  });
});

// ── GET /accounts?zip=XXXXX  or  ?name=XXXXX ──────────────────
//  Dedupe check — lets the form warn "this org may already be
//  in Salesforce" before creating a new Account.
app.get('/accounts', async (req, res) => {
  const zip  = (req.query.zip  || '').trim();
  const name = (req.query.name || '').trim();

  if (!zip && !name) {
    return res.status(400).json({ error: 'Provide either zip or name' });
  }
  if (zip && !isValidZip(zip)) {
    return res.status(400).json({ error: 'zip must be a 5-digit US ZIP code' });
  }

  try {
    const { access_token, instance_url } = await getSFToken();

    const whereClause = zip
      ? `BillingPostalCode LIKE '${zip}%'`
      : `Name LIKE '%${name.replace(/'/g, "\\'")}%'`;

    const soql = `
      SELECT Id, Name, BillingStreet, BillingCity, BillingState, BillingPostalCode
      FROM Account
      WHERE ${whereClause}
      AND IsDeleted = false
      ORDER BY Name
      LIMIT 50
    `.trim();

    const records = await sfQuery(instance_url, access_token, soql);

    const accounts = records.map(r => {
      const parts = [r.BillingStreet, r.BillingCity, r.BillingState, r.BillingPostalCode].filter(Boolean);
      return { id: r.Id, name: r.Name, address: parts.join(', ') };
    });

    res.json({ accounts });

  } catch (err) {
    console.error('/accounts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /submit ──────────────────────────────────────────────
//  sf_account_id === 'NEW'  →  POST  (creates new Account)
//  sf_account_id === real Id → PATCH (updates existing Account)
app.post('/submit', async (req, res) => {
  const payload = req.body;

  try {
    const { access_token, instance_url } = await getSFToken();

    const isNew = payload.sf_account_id === 'NEW';
    if (!isNew && !isValidSfId(payload.sf_account_id)) {
      return res.status(400).json({ success: false, error: 'sf_account_id must be a valid Salesforce ID or "NEW"' });
    }

    // Requested amount: optional server-side (so an older form keeps
    // working), but if one is sent it must be a positive number.
    const requestedAmount = parseAmount(payload.requested_amount);
    if (payload.requested_amount && requestedAmount === null) {
      return res.status(400).json({ success: false, error: 'Requested amount must be a positive number.' });
    }

    // Repeat inquiry from an organization already in Salesforce (matched
    // by EIN)? Reuse that Account instead of creating a duplicate; the
    // existing Account's data is left untouched.
    let existingAccountId = null;
    if (isNew && payload.ein) {
      existingAccountId = await findAccountIdByEin(instance_url, access_token, payload.ein);
    }

    const submissionId = generateSubmissionId();
    const timestamp     = payload.timestamp || new Date().toISOString();

    // ── FIELD MAPPING ─────────────────────────────────────────
    //  All fields below (standard and __c custom) are confirmed
    //  against the Dewan Foundation org's Account object.
    //
    //  Note: Industry is a single-value picklist, so the form sends
    //  one service choice (not a multi-select). The value sent must
    //  match Salesforce's stored picklist value exactly — for
    //  "Workforce Development" that's "Job Training", not the label
    //  shown on the form.
    const inquiryFields = {
      Type:                        'Nonprofit',
      Website:                     payload.website || '',
      // Question 1 only ("describe your organization"); how funding would
      // be used goes on the Funding Request. Older forms send just `description`.
      Description:                 payload.org_description || payload.description || '',
      Industry:                    payload.service || '',
      BillingStreet:               payload.street || '',
      BillingCity:                 payload.city || '',
      BillingState:                payload.state || '',
      BillingPostalCode:           payload.zip || '',

      Submission_ID__c:            submissionId,
      Submission_Timestamp__c:     timestamp,
      EIN_Number__c:               payload.ein || '',
      Services_Other_Detail__c:    payload.services_other || '',
      Scope__c:                    payload.region || '',
      Cities_Served__c:            payload.cities || '',
      Service_Site_Count__c:       payload.num_sites || '',
      Annual_Operating_Budget__c:  payload.annual_budget || '',
      Is_the_organization_faith_based__c: payload.faith_based || '',
      Faith_Affiliation__c:        payload.faith_affiliation || '',
      // Funding_Guidelines_Confirmed__c intentionally NOT written —
      // the form still requires the checkbox client-side, but per
      // instruction the answer isn't stored in Salesforce (for now).
    };

    let recordId, action;

    if (existingAccountId) {
      recordId = existingAccountId;
      action   = 'existing';
    } else if (isNew) {
      if (!payload.org_name) {
        return res.status(400).json({ success: false, error: 'org_name is required to create a new Account' });
      }
      // Explicitly set RecordTypeId so the new Account isn't created under
      // the org's default Record Type (Household Account, in NPSP orgs) —
      // otherwise NPSP automation overwrites Type back to "Household" no
      // matter what we send below.
      const recordTypeId = await getAccountRecordTypeId(instance_url, access_token);
      const newRecord = await sfPost(instance_url, access_token, SF_OBJECT, {
        Name: payload.org_name,
        ...(recordTypeId ? { RecordTypeId: recordTypeId } : {}),
        ...inquiryFields,
      });
      recordId = newRecord.id;
      action   = 'created';
    } else {
      await sfPatch(instance_url, access_token, SF_OBJECT, payload.sf_account_id, inquiryFields);
      recordId = payload.sf_account_id;
      action   = 'updated';
    }

    // ── CONTACT ─────────────────────────────────────────────────
    //  Standard Contact object, linked to the Account. For a brand-new
    //  Account it also becomes the Primary Contact; for an existing
    //  Account we reuse a Contact with the same email if there is one
    //  and leave the Account's Primary Contact alone.
    let contactId = null;
    if (payload.firstname || payload.lastname || payload.email) {
      if (action === 'existing') {
        contactId = await findContactIdByEmail(instance_url, access_token, recordId, payload.email);
      }
      if (!contactId) {
        const newContact = await sfPost(instance_url, access_token, 'Contact', {
          FirstName: payload.firstname || '',
          LastName:  payload.lastname  || '(unknown)', // Contact.LastName is required
          Email:     payload.email     || '',
          Title:     payload.title     || '',
          AccountId: recordId,
        });
        contactId = newContact.id;

        if (action !== 'existing') {
          await sfPatch(instance_url, access_token, SF_OBJECT, recordId, {
            npe01__One2OneContact__c: contactId,
          });
        }
      }
    }

    // ── FUNDING REQUEST ─────────────────────────────────────────
    //  One new Funding Request per submission. Status and Record Type
    //  are intentionally left unset (org defaults apply).
    const fundingProgramId = await getFundingProgramId(instance_url, access_token);
    const fundingUse = payload.funding_use || payload.description || '';
    const fundingRequest = await sfPost(instance_url, access_token, SF_FUNDING_REQUEST_OBJECT, {
      Name:                              buildFundingRequestName(payload.org_name, todayCentral()),
      outfunds__Applying_Organization__c: recordId,
      ...(contactId        ? { outfunds__Applying_Contact__c: contactId } : {}),
      ...(fundingProgramId ? { outfunds__FundingProgram__c: fundingProgramId } : {}),
      outfunds__Requested_For__c:        fundingUse,
      // Solar__c is a checkbox on the Funding Request; the form sends true/false.
      ...(typeof payload.solar === 'boolean' ? { Solar__c: payload.solar } : {}),
      ...(requestedAmount !== null ? { outfunds__Requested_Amount__c: requestedAmount } : {}),
      outfunds__Application_Date__c:     todayCentral(),
    });

    res.json({
      success: true,
      submissionId,
      record: { action, recordId, contactId, fundingRequestId: fundingRequest.id },
    });

  } catch (err) {
    console.error('/submit error:', err.message);

    // EIN_Number__c is a unique field on Account. If someone (re-)submits
    // an EIN that already belongs to another Account, Salesforce blocks
    // the write with DUPLICATE_VALUE — surface a clear, actionable message
    // instead of the raw Salesforce error JSON. (The full SF error,
    // including the existing record's Id, is still in the server log above.)
    const dupEin = err.sfErrors && err.sfErrors.find(
      e => e.errorCode === 'DUPLICATE_VALUE' && /EIN_Number__c/.test(e.message || '')
    );
    if (dupEin) {
      return res.status(409).json({
        success: false,
        error: 'An organization with this EIN is already in our system. Please contact the Dewan Foundation directly rather than submitting a new inquiry.',
      });
    }

    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dewan Foundation Funding Inquiry middleware v1.1 on port ${PORT}`);
  console.log(`SF Login:  ${SF_LOGIN_URL}`);
  console.log(`SF Object: ${SF_OBJECT}`);
  console.log(`Endpoints: GET /accounts  POST /submit`);
});
