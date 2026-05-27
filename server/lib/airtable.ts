const AIRTABLE_API_TOKEN = process.env.AIRTABLE_API_TOKEN;
const AIRTABLE_BASE_ID = "appF4oLhgbf143xe7";
const AIRTABLE_TABLE_NAME = "Creator Submissions";
const AIRTABLE_BRAND_APPLICATIONS_TABLE = "BrandApplications";

interface AirtableSignupData {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  authProvider: string;
  isApproved: boolean;
}

export async function addSignupToAirtable(data: AirtableSignupData): Promise<boolean> {
  if (!AIRTABLE_API_TOKEN) {
    console.warn("[Airtable] No API token configured, skipping sync");
    return false;
  }

  try {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${AIRTABLE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          Email: data.email,
          "First Name": data.firstName || "",
          "Last Name": data.lastName || "",
          "Auth Provider": data.authProvider,
          "Status": data.isApproved ? "Approved" : "Pending",
          "Signup Date": new Date().toISOString().split("T")[0],
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Airtable] Failed to add signup:", response.status, errorText);
      return false;
    }

    console.log(`[Airtable] Successfully added signup: ${data.email}`);
    return true;
  } catch (error) {
    console.error("[Airtable] Error adding signup:", error);
    return false;
  }
}

export interface AirtableSignupRecord {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  authProvider: string | null;
  status: string | null;
  signupDate: string | null;
  // Raw fields for anything we didn't map explicitly — Airtable bases
  // accumulate ad-hoc columns over time, surface them rather than drop.
  raw: Record<string, any>;
  createdTime: string | null;
}

/**
 * Brand application submitted via /api/brand-signup. Goes to a separate
 * Airtable table ("BrandApplications") rather than mixing with creator
 * submissions — brands have different fields (company, website) and
 * different approval flow (admin review required, no auto-approval).
 *
 * Expected Airtable columns in the BrandApplications table:
 *   Email            (single line text)
 *   First Name       (single line text)
 *   Last Name        (single line text)
 *   Company          (single line text)
 *   Website          (URL)
 *   Message          (long text)
 *   Status           (single select: Pending / Approved / Declined)
 *   Submitted Date   (date)
 *
 * Returns true on success, false on missing token or HTTP error. Errors
 * are logged but never thrown — the caller (POST /api/brand-signup)
 * should not fail the user's submission just because Airtable is down.
 */
export interface BrandApplicationData {
  email: string;
  firstName: string;
  lastName: string;
  companyName: string;
  websiteUrl?: string | null;
  message?: string | null;
}

export async function addBrandApplicationToAirtable(
  data: BrandApplicationData,
): Promise<boolean> {
  if (!AIRTABLE_API_TOKEN) {
    console.warn("[Airtable] No API token configured, skipping brand application sync");
    return false;
  }

  try {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_BRAND_APPLICATIONS_TABLE)}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          Email: data.email,
          "First Name": data.firstName,
          "Last Name": data.lastName,
          Company: data.companyName,
          Website: data.websiteUrl || "",
          Message: data.message || "",
          Status: "Pending",
          "Submitted Date": new Date().toISOString().split("T")[0],
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        "[Airtable] Failed to add brand application:",
        response.status,
        errorText,
      );
      return false;
    }

    console.log(`[Airtable] Added brand application: ${data.email} (${data.companyName})`);
    return true;
  } catch (error) {
    console.error("[Airtable] Error adding brand application:", error);
    return false;
  }
}

/** Fetch every signup record from Airtable. Handles pagination via offset.
 *  Returns null if the API token is missing. Throws on network/HTTP errors.
 */
export async function listAirtableSignups(): Promise<AirtableSignupRecord[] | null> {
  if (!AIRTABLE_API_TOKEN) {
    console.warn("[Airtable] No API token configured");
    return null;
  }

  const baseUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;
  const all: AirtableSignupRecord[] = [];
  let offset: string | undefined = undefined;
  // Hard cap so a runaway loop or massive base doesn't lock the request.
  const MAX_PAGES = 50; // 100 per page = 5000 records max
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(baseUrl);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_TOKEN}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable list failed ${res.status}: ${body.slice(0, 300)}`);
    }
    const data: any = await res.json();
    for (const r of (data.records || [])) {
      const f = r.fields || {};
      all.push({
        id: r.id,
        email: f.Email || null,
        firstName: f["First Name"] || null,
        lastName: f["Last Name"] || null,
        authProvider: f["Auth Provider"] || null,
        status: f.Status || null,
        signupDate: f["Signup Date"] || null,
        raw: f,
        createdTime: r.createdTime || null,
      });
    }
    offset = data.offset;
    if (!offset) break;
  }
  return all;
}
