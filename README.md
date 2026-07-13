# Dewan Foundation Funding Inquiry Middleware

Node.js/Express middleware connecting the Dewan Foundation Funding Inquiry form to Salesforce. Replaces the Google Form previously embedded at [dewanfoundation.org/funding-inquiries](https://www.dewanfoundation.org/funding-inquiries) (which wrote to a Google Sheet) — this writes directly to Salesforce instead. Modeled on the Solar Assessment Form middleware.

## Architecture

Form (`Dewan_Funding_Inquiry_Form.html`, hosted wherever the Wix embed points, e.g. Netlify) → Middleware (Heroku) → Salesforce (Dewan Foundation org)

The form never holds Salesforce credentials. All authentication happens here, using credentials stored as Heroku Config Vars.

## Heroku Config Vars

| Key | Required | Description |
|---|---|---|
| `SF_CLIENT_ID` | Yes | External Client App Consumer Key |
| `SF_CLIENT_SECRET` | Yes | External Client App Consumer Secret |
| `SF_LOGIN_URL` | Yes | `https://thejohnandsusandewanfoundation.my.salesforce.com` (My Domain URL — never login.salesforce.com) |
| `SF_OBJECT` | No | Object API name to write inquiries to. Default: `Account` |

## Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/` | Health check — returns status, version, target object |
| GET | `/accounts?zip=XXXXX` | Accounts matching a 5-digit ZIP (dedupe check — not currently used by the form UI) |
| GET | `/accounts?name=XXXXX` | Accounts matching a name fragment (dedupe check — not currently used by the form UI) |
| POST | `/submit` | Creates a new Account (or updates an existing one) with inquiry data |

`POST /submit` payload — mirrors the real form fields at dewanfoundation.org/funding-inquiries:

```json
{
  "sf_account_id": "NEW or an existing 18-char Salesforce Id",
  "org_name": "Required when sf_account_id is NEW",
  "website": "",
  "street": "", "city": "", "state": "", "zip": "",
  "ein": "",
  "description": "Brief org description + how funding would be used",
  "service": "Education | Job Training | Community Development | Food Insecurity | Housing Support | Other",
  "services_other": "",
  "region": "North America",
  "cities": "",
  "num_sites": "1 | 2-5 | 5+",
  "annual_budget": "Less than $500K | $500K - $1M | $1M - $5M | $5M - $10M | $10M+",
  "faith_based": "Yes | No",
  "faith_affiliation": "",
  "guidelines_confirmed": true,
  "firstname": "", "lastname": "", "email": "", "title": ""
}
```

Note: `guidelines_confirmed` is still sent in the payload (and still required client-side before the Submit button works), but the middleware does not write it to Salesforce. `firstname`/`lastname`/`email`/`title` don't map onto the Account at all — see "Contact handling" below.

## Field mapping

| Form field | Salesforce field | Status |
|---|---|---|
| Organization name | `Account.Name` | Standard — verified |
| Organization website | `Account.Website` | Standard — verified |
| Street / City / State / Zip | `Account.BillingStreet/City/State/PostalCode` | Standard — verified |
| Org description + funding use | `Account.Description` | Standard — verified |
| EIN | `Account.EIN_Number__c` | ✅ Created |
| Service provided (single-choice dropdown) | `Account.Industry` (standard picklist — single-value, so form is single-choice not checkboxes) | ✅ Standard — verified. Values sent must match Salesforce's stored value exactly: Education, **Job Training** (labeled "Workforce Development" on the form), Community Development, Food Insecurity, Housing Support, Other |
| "Other" service detail | `Account.Services_Other_Detail__c` | ✅ Created |
| Where services are provided | `Account.Scope__c` (labeled "Region") | ✅ Created |
| Cities/cities served | `Account.Cities_Served__c` | ✅ Created |
| Number of sites | `Account.Service_Site_Count__c` | ✅ Created |
| Annual operating budget | `Account.Annual_Operating_Budget__c` (picklist) | ✅ Created |
| Faith-based? | `Account.Is_the_organization_faith_based__c` | ✅ Created |
| Faith affiliation | `Account.Faith_Affiliation__c` | ✅ Created |
| Guidelines confirmation checkbox | Not stored | ✅ Confirmed by design — form still requires the checkbox before submitting, but the answer is intentionally **not** written to Salesforce (per instruction, for now) |
| First name, Last name, Email, Title | Standard `Contact` object (`FirstName`, `LastName`, `Email`, `Title`), linked via `AccountId` | ✅ Created as a real Contact record, not Account fields |
| Primary contact link | `Account.npe01__One2OneContact__c` | ✅ Set to the new Contact's Id after creation |

Any `__c` field above marked "needs to be created" will cause an `INVALID_FIELD` error on submit. Create these in Setup → Object Manager → Account before go-live, or tell me the actual API names once created and I'll update `server.js` to match.

### Contact handling

Unlike the fields above, contact info (name/email/title) does **not** get written onto the Account. Instead, `POST /submit` now:
1. Creates or updates the Account as before
2. Creates a new `Contact` record (`FirstName`, `LastName`, `Email`, `Title`) with `AccountId` set to that Account
3. Patches the Account's `npe01__One2OneContact__c` (Primary Contact) to point at the new Contact

`LastName` is required by Salesforce on Contact — if it's ever blank, the middleware sends `"(unknown)"` as a fallback so the create doesn't fail outright, though the form itself requires it before submit is even enabled.

## Deploying

1. Push `files/` to the `main` branch of a new repository (e.g. `dw-funding-inquiry-middleware`)
2. Heroku → New app → Deploy tab → connect the repo → Deploy Branch
3. Set the Config Vars above
4. Verify the health check at the app URL returns `{ "status": "ok" }`
5. Update `MIDDLEWARE` in `Dewan_Funding_Inquiry_Form.html` to the deployed Heroku URL
6. Host `Dewan_Funding_Inquiry_Form.html` (e.g. Netlify) and swap the Wix embed at dewanfoundation.org/funding-inquiries from the Google Form iframe to this page

## Eligibility gate

The form asks "Does your organization have 501(c)(3) status?" before the EIN question. A "No" answer shows an ineligibility message and stops the form there — no EIN, services, or other fields render, and there's no submit button, so nothing is ever sent to the middleware. Only a "Yes" answer reveals the rest of the form.

## Known open items

- All fields in the mapping table above are now confirmed against the Dewan Foundation org — no more unverified `__c` fields.
- The original form had no way to check for duplicate Accounts (every submission went to a fresh Google Sheet row). This middleware exposes `GET /accounts` for that purpose, but the form UI doesn't call it yet — every submission currently creates a brand-new Account. Decide whether first-time inquiries should be checked against existing Accounts (e.g. an org that already has a relationship with Dewan through the Solar program) before deciding whether to wire up a dedupe step.
- No file uploads on this form (unlike the Solar Assessment form) — nothing to build there.
