/**
 * Audience analytics fetcher for the multi-account creator profile.
 *
 * Pulls demographics + engagement from each platform's analytics API
 * and parses into the standard shape we store in
 * social_accounts.audience_data.
 *
 * Validated against live probes (see docs/adr/001-multi-account-creator-profile.md
 * §1 Schema for the audience_data shape, and the probe commits that proved
 * each platform endpoint works for our test account):
 *
 *   - Instagram: follower_demographics requires single-breakdown calls
 *     (combining breakdowns returns 500). One call each for age, gender,
 *     country, city. Plus follower_count + reach for basic engagement.
 *
 *   - YouTube: youtubeanalytics.googleapis.com endpoints work with the
 *     yt-analytics.readonly scope. Channel-level metrics, demographics
 *     (ageGroup × gender), and top countries.
 *
 *   - Facebook Page: Meta deprecated audience demographics in late 2024.
 *     Only follower_count remains accessible at the API layer.
 */

// ─── Standard output shape ─────────────────────────────────────────────

export interface AudienceData {
  // Demographics — proportions sum to ~1.0 within each distribution
  age_distribution?: Record<string, number> | null;
  gender_distribution?: Record<string, number> | null;
  top_countries?: Array<{ code: string; percent: number }> | null;
  top_cities?: Array<{ name: string; percent: number }> | null;
  language_distribution?: Array<{ lang: string; percent: number }> | null;

  // Engagement (where available)
  engagement?: {
    follower_count?: number | null;
    reach?: number | null;
    total_interactions?: number | null;
    estimated_minutes_watched?: number | null;
    average_view_duration?: number | null;
    subscribers_gained?: number | null;
  } | null;

  // Source platform raw response, kept for debugging and future fields
  raw?: any;

  // Per-call status — useful when some calls succeed and others fail
  errors?: Record<string, string>;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function normalizeDistribution(rawCounts: Record<string, number>): Record<string, number> {
  const total = Object.values(rawCounts).reduce((sum, v) => sum + (typeof v === "number" ? v : 0), 0);
  if (total === 0) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawCounts)) {
    if (typeof value === "number") out[key] = value / total;
  }
  return out;
}

async function fetchJson(url: string): Promise<{ ok: boolean; status: number; data: any }> {
  const r = await fetch(url);
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}

async function fetchJsonWithBearer(url: string, accessToken: string): Promise<{ ok: boolean; status: number; data: any }> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}

// ─── Instagram (Business / Creator) ────────────────────────────────────

/**
 * Resolves a Page Access Token for the given IG Business id by walking
 * the user token's /me/accounts and matching on instagram_business_account.id.
 *
 * IG Insights endpoints prefer Page tokens; they reject user tokens for
 * accounts owned through Business Manager.
 */
async function resolvePageTokenForIg(
  igBusinessId: string,
  userToken: string
): Promise<string | null> {
  const res = await fetchJson(
    `https://graph.facebook.com/v25.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${userToken}`
  );
  if (!res.ok) return null;
  const pages: any[] = res.data?.data || [];
  for (const p of pages) {
    if (p.instagram_business_account?.id === igBusinessId && p.access_token) {
      return p.access_token;
    }
  }
  return null;
}

export async function fetchInstagramAudience(
  igBusinessId: string,
  userToken: string
): Promise<AudienceData> {
  const errors: Record<string, string> = {};
  const out: AudienceData = { errors };

  if (!userToken) {
    errors.token = "Missing user token";
    return out;
  }

  // Page token preferred for Insights; fall back to user token if unresolved
  const pageToken = await resolvePageTokenForIg(igBusinessId, userToken);
  const insightsToken = pageToken || userToken;

  const insightsBase = `https://graph.facebook.com/v25.0/${igBusinessId}/insights`;

  // ── Demographics: 4 single-breakdown calls (combining → 500) ──
  const breakdownToOutKey: Record<string, "age" | "gender" | "country" | "city"> = {
    age: "age",
    gender: "gender",
    country: "country",
    city: "city",
  };

  const rawDemos: Record<string, Record<string, number>> = {};

  for (const breakdown of Object.keys(breakdownToOutKey)) {
    const url = `${insightsBase}?metric=follower_demographics&breakdown=${breakdown}&metric_type=total_value&period=lifetime&access_token=${insightsToken}`;
    const res = await fetchJson(url);
    if (!res.ok) {
      errors[`demographics_${breakdown}`] = res.data?.error?.message || `HTTP ${res.status}`;
      continue;
    }
    // Response shape: { data: [{ name: "follower_demographics", total_value: { breakdowns: [{ dimension_values: [...], value: N }] } }] }
    // OR older shape: { data: [{ name: "follower_demographics", values: [{ value: {KEY: N, ...} }] }] }
    const node = res.data?.data?.[0];
    const counts: Record<string, number> = {};

    // Newer shape: total_value.breakdowns
    const breakdownsArr = node?.total_value?.breakdowns?.[0]?.results;
    if (Array.isArray(breakdownsArr)) {
      for (const row of breakdownsArr) {
        const key: string = row?.dimension_values?.[0];
        const value: number = row?.value;
        if (key && typeof value === "number") counts[key] = value;
      }
    } else {
      // Older shape: values[0].value as a flat object
      const flat = node?.values?.[0]?.value;
      if (flat && typeof flat === "object") {
        for (const [k, v] of Object.entries(flat)) {
          if (typeof v === "number") counts[k] = v;
        }
      }
    }

    rawDemos[breakdown] = counts;
  }

  if (Object.keys(rawDemos.age || {}).length > 0) {
    out.age_distribution = normalizeDistribution(rawDemos.age);
  }
  if (Object.keys(rawDemos.gender || {}).length > 0) {
    // IG returns "F", "M", "U" — map to readable
    const norm = normalizeDistribution(rawDemos.gender);
    out.gender_distribution = {
      female: norm["F"] ?? 0,
      male: norm["M"] ?? 0,
      other: norm["U"] ?? 0,
    };
  }
  if (Object.keys(rawDemos.country || {}).length > 0) {
    const norm = normalizeDistribution(rawDemos.country);
    out.top_countries = Object.entries(norm)
      .map(([code, percent]) => ({ code, percent }))
      .sort((a, b) => b.percent - a.percent)
      .slice(0, 10);
  }
  if (Object.keys(rawDemos.city || {}).length > 0) {
    const norm = normalizeDistribution(rawDemos.city);
    out.top_cities = Object.entries(norm)
      .map(([name, percent]) => ({ name, percent }))
      .sort((a, b) => b.percent - a.percent)
      .slice(0, 10);
  }

  // ── Engagement: follower_count, reach, total_interactions ──
  const engagementUrl = `${insightsBase}?metric=follower_count,reach&period=day&access_token=${insightsToken}`;
  const engRes = await fetchJson(engagementUrl);
  if (engRes.ok && Array.isArray(engRes.data?.data)) {
    const engagement: NonNullable<AudienceData["engagement"]> = {};
    for (const metric of engRes.data.data) {
      const latest = metric.values?.[metric.values.length - 1]?.value;
      if (typeof latest === "number") {
        if (metric.name === "follower_count") engagement.follower_count = latest;
        if (metric.name === "reach") engagement.reach = latest;
      }
    }
    out.engagement = engagement;
  } else {
    errors.engagement = engRes.data?.error?.message || `HTTP ${engRes.status}`;
  }

  // total_interactions needs metric_type=total_value (separate call per Meta's error message)
  const interactionsUrl = `${insightsBase}?metric=total_interactions&metric_type=total_value&period=day&access_token=${insightsToken}`;
  const intRes = await fetchJson(interactionsUrl);
  if (intRes.ok && Array.isArray(intRes.data?.data)) {
    const totalValue = intRes.data.data[0]?.total_value?.value;
    if (typeof totalValue === "number") {
      out.engagement = { ...(out.engagement || {}), total_interactions: totalValue };
    }
  }

  out.raw = { rawDemos };
  if (Object.keys(errors).length === 0) delete out.errors;
  return out;
}

// ─── YouTube ───────────────────────────────────────────────────────────

/**
 * Note: YouTube tokens are stored ENCRYPTED in social_accounts but the
 * legacy youtube_connections.accessToken is also encrypted. The caller
 * is responsible for refresh-on-expiry; this function assumes the token
 * is currently valid.
 */
export async function fetchYoutubeAudience(
  channelId: string,
  accessToken: string
): Promise<AudienceData> {
  const errors: Record<string, string> = {};
  const out: AudienceData = { errors };

  if (!accessToken) {
    errors.token = "Missing YouTube access token";
    return out;
  }

  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // ── Channel metrics: views, subscribers gained, watch time ──
  const metricsUrl = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE&startDate=${startDate}&endDate=${endDate}&metrics=views,subscribersGained,estimatedMinutesWatched,averageViewDuration`;
  const metricsRes = await fetchJsonWithBearer(metricsUrl, accessToken);
  if (metricsRes.ok && metricsRes.data?.rows?.[0]) {
    const headers: any[] = metricsRes.data.columnHeaders || [];
    const row: any[] = metricsRes.data.rows[0];
    const m: NonNullable<AudienceData["engagement"]> = {};
    headers.forEach((h, i) => {
      const v = row[i];
      if (typeof v !== "number") return;
      if (h.name === "views") m.reach = v;
      if (h.name === "subscribersGained") m.subscribers_gained = v;
      if (h.name === "estimatedMinutesWatched") m.estimated_minutes_watched = v;
      if (h.name === "averageViewDuration") m.average_view_duration = v;
    });
    out.engagement = m;
  } else {
    errors.metrics = metricsRes.data?.error?.message || `HTTP ${metricsRes.status}`;
  }

  // ── Demographics: ageGroup × gender → viewerPercentage ──
  const demoUrl = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE&startDate=${startDate}&endDate=${endDate}&dimensions=ageGroup,gender&metrics=viewerPercentage`;
  const demoRes = await fetchJsonWithBearer(demoUrl, accessToken);
  if (demoRes.ok && Array.isArray(demoRes.data?.rows)) {
    const ageCounts: Record<string, number> = {};
    const genderCounts: Record<string, number> = {};
    for (const row of demoRes.data.rows) {
      // row = [ageGroup, gender, viewerPercentage]
      const ageGroup = String(row[0] || "").replace(/^age/, "");
      const gender = String(row[1] || "").toLowerCase();
      const pct = typeof row[2] === "number" ? row[2] : 0;
      ageCounts[ageGroup] = (ageCounts[ageGroup] || 0) + pct;
      genderCounts[gender] = (genderCounts[gender] || 0) + pct;
    }
    if (Object.keys(ageCounts).length > 0) {
      out.age_distribution = normalizeDistribution(ageCounts);
    }
    if (Object.keys(genderCounts).length > 0) {
      out.gender_distribution = normalizeDistribution(genderCounts);
    }
  } else if (demoRes.ok && demoRes.data?.rows?.length === 0) {
    // Below YouTube's threshold for demographic surfacing — common for newer
    // channels. Not an error; just no data yet.
    errors.demographics = "Below threshold (channel has not yet accumulated enough watch time for YouTube to surface demographics)";
  } else {
    errors.demographics = demoRes.data?.error?.message || `HTTP ${demoRes.status}`;
  }

  // ── Top countries by views ──
  const countriesUrl = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE&startDate=${startDate}&endDate=${endDate}&dimensions=country&metrics=views&sort=-views&maxResults=10`;
  const countriesRes = await fetchJsonWithBearer(countriesUrl, accessToken);
  if (countriesRes.ok && Array.isArray(countriesRes.data?.rows)) {
    const counts: Record<string, number> = {};
    for (const row of countriesRes.data.rows) {
      const code = String(row[0] || "").toUpperCase();
      const views = typeof row[1] === "number" ? row[1] : 0;
      if (code) counts[code] = views;
    }
    const norm = normalizeDistribution(counts);
    out.top_countries = Object.entries(norm)
      .map(([code, percent]) => ({ code, percent }))
      .sort((a, b) => b.percent - a.percent)
      .slice(0, 10);
  } else {
    errors.countries = countriesRes.data?.error?.message || `HTTP ${countriesRes.status}`;
  }

  out.raw = {
    metrics: metricsRes.data,
    demographics: demoRes.data,
    countries: countriesRes.data,
  };
  if (Object.keys(errors).length === 0) delete out.errors;
  return out;
}

// ─── Facebook Page ─────────────────────────────────────────────────────

/**
 * Page audience demographics are deprecated by Meta (late 2024); only
 * the basic follower count remains. Returns engagement with follower_count
 * and leaves the demographic fields null.
 */
export async function fetchFacebookPageAudience(
  pageId: string,
  userToken: string
): Promise<AudienceData> {
  const errors: Record<string, string> = {};
  const out: AudienceData = { errors };

  if (!userToken) {
    errors.token = "Missing user token";
    return out;
  }

  // Direct Page fetch — followers_count is on the Page node itself,
  // no Insights call needed and no demographic API exists.
  const url = `https://graph.facebook.com/v25.0/${pageId}?fields=id,name,followers_count,fan_count&access_token=${userToken}`;
  const res = await fetchJson(url);
  if (res.ok && res.data?.id) {
    out.engagement = {
      follower_count: res.data.followers_count ?? res.data.fan_count ?? 0,
    };
    out.raw = res.data;
  } else {
    errors.page = res.data?.error?.message || `HTTP ${res.status}`;
  }

  errors.demographics = "Page audience demographics deprecated by Meta in late 2024 (no API replacement)";

  return out;
}
