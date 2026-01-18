import type { Express } from "express";
import { authStorage } from "./storage";

// Register auth-specific routes
export function registerAuthRoutes(app: Express): void {
  // Get current authenticated user - supports multiple auth methods
  // Priority: Google OAuth > Replit OIDC > Facebook session
  app.get("/api/auth/user", async (req: any, res) => {
    try {
      const isDev = process.env.NODE_ENV !== 'production';
      
      // Debug: Log session state (development only)
      if (isDev) {
        console.log("[Auth User] Session ID:", req.sessionID);
        console.log("[Auth User] Session userId:", req.session?.userId);
        console.log("[Auth User] Session googleUser:", req.session?.googleUser ? "present" : "missing");
        console.log("[Auth User] req.user:", req.user ? "present" : "missing");
      }
      
      // Try Google OAuth session first
      const googleUser = req.session?.googleUser;
      if (googleUser && googleUser.email) {
        if (isDev) console.log("[Auth User] Found Google OAuth user:", googleUser.email);
        const user = await authStorage.getUserByEmail(googleUser.email);
        if (user) {
          return res.json(user);
        }
        // Create a minimal user object from session
        return res.json({
          id: googleUser.email,
          email: googleUser.email,
          firstName: googleUser.name?.split(' ')[0] || null,
          lastName: googleUser.name?.split(' ').slice(1).join(' ') || null,
          profileImageUrl: googleUser.picture || null,
        });
      }

      // Try Replit OIDC Auth (Passport-based)
      if (req.isAuthenticated && req.isAuthenticated() && req.user?.claims) {
        if (isDev) console.log("[Auth User] Found Replit OIDC user");
        const userId = req.user.claims.sub;
        const user = await authStorage.getUser(userId);
        if (user) {
          return res.json(user);
        }
      }

      // Try Facebook session auth (via req.session.userId)
      const sessionUserId = req.session?.userId;
      if (sessionUserId) {
        if (isDev) console.log("[Auth User] Found Facebook session userId:", sessionUserId);
        const user = await authStorage.getUser(sessionUserId);
        if (user) {
          if (isDev) console.log("[Auth User] Returning Facebook user:", user.email);
          return res.json(user);
        }
        if (isDev) console.log("[Auth User] No user found for session userId:", sessionUserId);
      }

      // Not authenticated
      if (isDev) console.log("[Auth User] No auth method found, returning 401");
      return res.status(401).json({ message: "Unauthorized" });
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });
}
