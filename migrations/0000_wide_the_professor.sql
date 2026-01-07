CREATE TABLE "allowed_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar NOT NULL,
	"name" varchar,
	"added_at" timestamp DEFAULT now(),
	CONSTRAINT "allowed_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "detected_surfaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"timestamp" numeric NOT NULL,
	"surface_type" varchar NOT NULL,
	"confidence" numeric NOT NULL,
	"bounding_box_x" numeric NOT NULL,
	"bounding_box_y" numeric NOT NULL,
	"bounding_box_width" numeric NOT NULL,
	"bounding_box_height" numeric NOT NULL,
	"frame_url" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "monetization_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"thumbnail_url" text,
	"date" timestamp DEFAULT now(),
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_index" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"youtube_id" varchar NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"view_count" integer DEFAULT 0 NOT NULL,
	"thumbnail_url" text,
	"status" varchar DEFAULT 'Pending Scan' NOT NULL,
	"priority_score" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp,
	"category" varchar,
	"is_evergreen" boolean DEFAULT false,
	"duration" varchar,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "youtube_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp,
	"channel_id" text,
	"channel_title" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "youtube_connections_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar,
	"first_name" varchar,
	"last_name" varchar,
	"profile_image_url" varchar,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "sessions" USING btree ("expire");