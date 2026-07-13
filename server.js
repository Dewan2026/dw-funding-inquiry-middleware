// ============================================================
//  Dewan Foundation First-Time Funding Inquiry — Middleware v1
//
//  Replaces the Google Form at dewanfoundation.org/funding-inquiries
//  (previously wrote to a Google Sheet) — writes directly to
//  Salesforce instead.
//
//  GET  /accounts?zip=XXXXX   → Query SF Accounts by ZIP (dedupe check)
//  GET  /accounts?name=XXXXX  → Query SF Accounts by Name (dedupe check)
//  POST /submit                → Write inquiry data to Salesforce (Account)
//
//  Config (Heroku Config Vars):
//    SF_CLIENT_ID       Consumer Key  (External Client App)
//    SF_CLIENT_SECRET   Consumer Secret
//    SF_LOGIN_URL       https://thejohnandsusandewanfoundation.my.salesforce.com
//    SF_OBJECT          Salesforce object API name   (default: Account)
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
  if (!res.ok) throw new Error(`SF POST ${object} failed: ${JSON.stringify(body)}`);
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
  if (!res.ok) throw new Error(`SF PATCH ${object} failed: ${JSON.stringify(body)}`);
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
    version:  '1.0',
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
      Website:                     payload.website || '',
      Description:                 payload.description || '',
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

    if (isNew) {
      if (!payload.org_name) {
        return res.status(400).json({ success: false, error: 'org_name is required to create a new Account' });
      }
      const newRecord = await sfPost(instance_url, access_token, SF_OBJECT, {
        Name: payload.org_name,
        ...inquiryFields,
      });
      recordId = newRecord.id;
      action   = 'created';
    } else {
      await sfPatch(instance_url, access_token, SF_OBJECT, payload.sf_account_id, inquiryFields);
      recordId = payload.sf_account_id;
      action   = 'updated';
    }

    // ── PRIMARY CONTACT ─────────────────────────────────────────
    //  Contacts go into the standard Contact object (not custom
    //  fields on Account). Create the Contact linked to this Account,
    //  then point the Account's Primary Contact lookup at it.
    let contactId = null;
    if (payload.firstname || payload.lastname || payload.email) {
      const newContact = await sfPost(instance_url, access_token, 'Contact', {
        FirstName: payload.firstname || '',
        LastName:  payload.lastname  || '(unknown)', // Contact.LastName is required
        Email:     payload.email     || '',
        Title:     payload.title     || '',
        AccountId: recordId,
      });
      contactId = newContact.id;

      await sfPatch(instance_url, access_token, SF_OBJECT, recordId, {
        npe01__One2OneContact__c: contactId,
      });
    }

    res.json({ success: true, submissionId, record: { action, recordId, contactId } });

  } catch (err) {
    console.error('/submit error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dewan Foundation Funding Inquiry middleware v1 on port ${PORT}`);
  console.log(`SF Login:  ${SF_LOGIN_URL}`);
  console.log(`SF Object: ${SF_OBJECT}`);
  console.log(`Endpoints: GET /accounts  POST /submit`);
});
