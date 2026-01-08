import { db } from "../db";
import { monetizationItems, videoIndex, detectedSurfaces, allowedUsers } from "@shared/schema";

const LOCAL_VIDEO_FILES = [
  "/hero_video.mp4",
  "/many_jobs.mov",
  "/quick_update.mov",
  "/fullscale_final4.mov",
];

const THUMBNAIL_COLORS = [
  "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop",
  "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop",
  "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop",
  "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop",
  "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop",
];

const BRAND_CAMPAIGNS = [
  { brandName: "CloudScale", brandEmail: "partnerships@cloudscale.io", category: "Tech/SaaS", budget: 15000, status: "Active", sceneType: "Monitor", genre: "Tech" },
  { brandName: "DevOps Now", brandEmail: "sponsor@devopsnow.com", category: "Tech/SaaS", budget: 18000, status: "Recruiting", sceneType: "Laptop", genre: "Tech" },
  { brandName: "ServerlessHQ", brandEmail: "creators@serverlesshq.io", category: "Tech/SaaS", budget: 12000, status: "Active", sceneType: "Desk", genre: "Tech" },
  { brandName: "GitFlow Pro", brandEmail: "marketing@gitflowpro.com", category: "Tech/SaaS", budget: 16500, status: "Urgent", sceneType: "Monitor", genre: "Tech" },
  { brandName: "APIForge", brandEmail: "partners@apiforge.dev", category: "Tech/SaaS", budget: 14000, status: "Active", sceneType: "Laptop", genre: "Tech" },
  { brandName: "DataVault", brandEmail: "sponsor@datavault.io", category: "Tech/SaaS", budget: 17500, status: "Recruiting", sceneType: "Desk", genre: "Tech" },
  { brandName: "WealthStack", brandEmail: "creators@wealthstack.com", category: "Finance", budget: 8500, status: "Active", sceneType: "Monitor", genre: "Finance" },
  { brandName: "CryptoLedger", brandEmail: "partnerships@cryptoledger.io", category: "Finance", budget: 9200, status: "Recruiting", sceneType: "Laptop", genre: "Finance" },
  { brandName: "BudgetWise", brandEmail: "sponsor@budgetwise.app", category: "Finance", budget: 7800, status: "Active", sceneType: "Desk", genre: "Finance" },
  { brandName: "InvestFlow", brandEmail: "marketing@investflow.co", category: "Finance", budget: 8000, status: "Urgent", sceneType: "Monitor", genre: "Finance" },
  { brandName: "TaxSimple", brandEmail: "creators@taxsimple.com", category: "Finance", budget: 6500, status: "Active", sceneType: "Laptop", genre: "Finance" },
  { brandName: "PortfolioMax", brandEmail: "partners@portfoliomax.io", category: "Finance", budget: 9500, status: "Recruiting", sceneType: "Desk", genre: "Finance" },
  { brandName: "HydraFlask", brandEmail: "influencers@hydraflask.com", category: "Lifestyle", budget: 5000, status: "Active", sceneType: "Table", genre: "Lifestyle" },
  { brandName: "Lumina Desk", brandEmail: "creators@luminadesk.co", category: "Lifestyle", budget: 5500, status: "Recruiting", sceneType: "Desk", genre: "Lifestyle" },
  { brandName: "ZenMat", brandEmail: "partnerships@zenmat.life", category: "Lifestyle", budget: 4200, status: "Active", sceneType: "Wall", genre: "Lifestyle" },
  { brandName: "AromaBlend", brandEmail: "sponsor@aromablend.co", category: "Lifestyle", budget: 4800, status: "Urgent", sceneType: "Shelf", genre: "Lifestyle" },
  { brandName: "EcoBottle", brandEmail: "creators@ecobottle.green", category: "Lifestyle", budget: 3800, status: "Active", sceneType: "Table", genre: "Lifestyle" },
  { brandName: "SleepCloud", brandEmail: "marketing@sleepcloud.io", category: "Lifestyle", budget: 6000, status: "Recruiting", sceneType: "Wall", genre: "Lifestyle" },
  { brandName: "Notion Templates", brandEmail: "creators@notionpro.co", category: "Productivity", budget: 7000, status: "Active", sceneType: "Monitor", genre: "Productivity" },
  { brandName: "FocusMate", brandEmail: "partnerships@focusmate.app", category: "Productivity", budget: 6500, status: "Recruiting", sceneType: "Laptop", genre: "Productivity" },
  { brandName: "TaskFlow", brandEmail: "sponsor@taskflow.io", category: "Productivity", budget: 5800, status: "Active", sceneType: "Desk", genre: "Productivity" },
  { brandName: "CalendarAI", brandEmail: "creators@calendarai.com", category: "Productivity", budget: 7500, status: "Urgent", sceneType: "Monitor", genre: "Productivity" },
  { brandName: "MindMap Pro", brandEmail: "marketing@mindmappro.co", category: "Productivity", budget: 6200, status: "Active", sceneType: "Laptop", genre: "Productivity" },
  { brandName: "TimeBlock", brandEmail: "partners@timeblock.app", category: "Productivity", budget: 5500, status: "Recruiting", sceneType: "Desk", genre: "Productivity" },
  { brandName: "HabitStack", brandEmail: "influencers@habitstack.io", category: "Productivity", budget: 4800, status: "Active", sceneType: "Monitor", genre: "Productivity" },
];

const VIDEO_TITLES = [
  "My 2025 Desk Setup - Ultimate Productivity Tour",
  "iPhone 16 Pro Max Review - 3 Months Later",
  "Q3 Vlog: Behind the Scenes",
  "Morning Routine for Maximum Focus",
  "Studio Tour 2025 - New Upgrades",
  "MacBook Pro M4 - Real World Test",
  "Content Creator Workflow Secrets",
  "Budget vs Premium Tech Comparison",
  "How I Edit Videos in 2025",
  "Home Office Makeover Reveal",
  "Tech I Regret Buying This Year",
  "Day in My Life as a Creator",
  "Productivity Apps I Use Daily",
  "New Camera Setup Walkthrough",
  "Minimalist Desk Organization",
  "Work From Home Tips That Actually Work",
  "Best Gadgets Under $100",
  "My Filming Setup Explained",
  "Creator Economy Deep Dive",
  "Honest Review: Standing Desk",
];

const SURFACE_TYPES = ["Desk", "Monitor", "Laptop", "Wall", "Shelf", "Table", "Bottle"];

export async function seed() {
  console.log("Starting database seed...");

  const martinUserId = "martin-demo-user";

  try {
    await db.delete(detectedSurfaces);
    await db.delete(monetizationItems);
    await db.delete(videoIndex);
    console.log("Cleared existing seed data");
  } catch (e) {
    console.log("Tables may not exist yet, continuing...");
  }

  console.log("Inserting 25 brand campaigns...");
  for (const campaign of BRAND_CAMPAIGNS) {
    await db.insert(monetizationItems).values({
      title: `${campaign.brandName} - ${campaign.category} Campaign`,
      thumbnailUrl: THUMBNAIL_COLORS[Math.floor(Math.random() * THUMBNAIL_COLORS.length)],
      status: campaign.status.toLowerCase(),
      creatorUserId: martinUserId,
      brandEmail: campaign.brandEmail,
      brandName: campaign.brandName,
      bidAmount: campaign.budget.toString(),
      sceneType: campaign.sceneType,
      genre: campaign.genre,
    });
  }
  console.log("Brand campaigns inserted");

  console.log("Inserting 20 filler videos for Martin...");
  const insertedVideos: { id: number; status: string }[] = [];
  
  for (let i = 0; i < 20; i++) {
    const randomNum = Math.random();
    let scanStatus: string;
    let opportunitiesFound: number;
    
    if (randomNum < 0.7) {
      scanStatus = "Scan Complete";
      opportunitiesFound = Math.floor(Math.random() * 5) + 1;
    } else if (randomNum < 0.9) {
      scanStatus = Math.random() < 0.5 ? "Pending Scan" : "Scanning...";
      opportunitiesFound = 0;
    } else {
      scanStatus = "Scan Failed";
      opportunitiesFound = 0;
    }

    const viewCount = Math.floor(Math.random() * 500000) + 10000;
    const daysAgo = Math.floor(Math.random() * 365);
    const publishedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

    const [inserted] = await db.insert(videoIndex).values({
      userId: martinUserId,
      youtubeId: `demo-video-${i + 1}`,
      title: VIDEO_TITLES[i],
      description: `A great video about ${VIDEO_TITLES[i].toLowerCase()}. Perfect for brand integrations.`,
      viewCount,
      thumbnailUrl: THUMBNAIL_COLORS[i % THUMBNAIL_COLORS.length],
      status: scanStatus,
      priorityScore: Math.floor(Math.random() * 100),
      publishedAt,
      category: ["Tech", "Lifestyle", "Productivity", "Vlog"][Math.floor(Math.random() * 4)],
      isEvergreen: Math.random() > 0.3,
      duration: `${Math.floor(Math.random() * 15) + 5}:${String(Math.floor(Math.random() * 60)).padStart(2, "0")}`,
    }).returning();

    insertedVideos.push({ id: inserted.id, status: scanStatus });
  }
  console.log("Videos inserted");

  console.log("Inserting detected surfaces for completed scans...");
  for (const video of insertedVideos) {
    if (video.status === "Scan Complete") {
      const surfaceCount = Math.floor(Math.random() * 4) + 1;
      for (let j = 0; j < surfaceCount; j++) {
        await db.insert(detectedSurfaces).values({
          videoId: video.id,
          timestamp: (Math.random() * 300 + 10).toFixed(2),
          surfaceType: SURFACE_TYPES[Math.floor(Math.random() * SURFACE_TYPES.length)],
          confidence: (Math.random() * 0.3 + 0.7).toFixed(2),
          boundingBoxX: (Math.random() * 0.5).toFixed(3),
          boundingBoxY: (Math.random() * 0.5).toFixed(3),
          boundingBoxWidth: (Math.random() * 0.3 + 0.1).toFixed(3),
          boundingBoxHeight: (Math.random() * 0.3 + 0.1).toFixed(3),
        });
      }
    }
  }
  console.log("Detected surfaces inserted");

  console.log("Database seed completed successfully!");
  console.log(`- ${BRAND_CAMPAIGNS.length} brand campaigns`);
  console.log(`- ${VIDEO_TITLES.length} creator videos`);
  console.log(`- Surfaces for ${insertedVideos.filter(v => v.status === "Scan Complete").length} completed scans`);
}

// Only run seed directly when executed as a script
// Check if this file is being run directly (ES module compatible)
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}
