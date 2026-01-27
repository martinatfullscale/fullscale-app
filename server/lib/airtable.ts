const AIRTABLE_API_TOKEN = process.env.AIRTABLE_API_TOKEN;
const AIRTABLE_BASE_ID = "appF4oLhgbf143xe7";
const AIRTABLE_TABLE_NAME = "Creator Submissions";

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
