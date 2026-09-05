/**
 * Drizzle definitions for the portal schema.
 *
 * The authoritative DDL is drizzle/0001_init.sql, which is what actually runs
 * against Supabase. This file mirrors it for typed queries. If you change one,
 * change both.
 */

import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    fullName: text("full_name"),
    imageUrl: text("image_url"),
    role: text("role", { enum: ["owner", "client"] }).notNull().default("client"),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    invitedBy: uuid("invited_by"),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("users_client_idx").on(table.clientId)],
);

export const sites = pgTable(
  "sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    location: text("location"),
    district: text("district"),
    state: text("state"),
    areaLabel: text("area_label"),
    industry: text("industry"),
    status: text("status", { enum: ["in_progress", "delivered", "archived"] })
      .notNull()
      .default("delivered"),
    summary: text("summary"),
    thumbnailKey: text("thumbnail_key"),
    isPublished: boolean("is_published").notNull().default(false),
    /*
     * This survey's own vertical accuracy, from its checkpoint report, and null
     * until one has been supplied — which is the state of every site today.
     *
     * Null is not a missing value to be filled in with a default. It is the
     * fact that we have not measured this survey, and drizzle/0003 refuses a
     * figure that arrives without its basis, its checkpoint count and its date,
     * because a bare number here is how "±4 cm" came to be printed under every
     * elevation in the portal in the first place.
     *
     * numeric, not real: the figure is quoted to the client in centimetres and
     * a float would make 0.035 render as 3.4999999 cm somewhere eventually.
     */
    verticalRmseZM: numeric("vertical_rmse_z_m"),
    verticalAccuracyBasis: text("vertical_accuracy_basis", { enum: ["rmse", "ci95"] }),
    verticalAccuracyCheckpoints: integer("vertical_accuracy_checkpoints"),
    verticalAccuracyAssessedOn: date("vertical_accuracy_assessed_on"),
    verticalAccuracyMethod: text("vertical_accuracy_method"),
    verticalAccuracySource: text("vertical_accuracy_source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("sites_client_id_slug_key").on(table.clientId, table.slug),
    index("sites_client_idx").on(table.clientId),
  ],
);

export const surveys = pgTable(
  "surveys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    flownOn: date("flown_on").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("surveys_site_idx").on(table.siteId)],
);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    surveyId: uuid("survey_id").references(() => surveys.id, { onDelete: "set null" }),
    category: text("category", {
      enum: ["report", "drawing", "photo", "uav_dgps", "lidar", "control_area", "misc"],
    }).notNull(),
    title: text("title").notNull(),
    fileName: text("file_name").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    description: text("description"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    isPublished: boolean("is_published").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("assets_site_category_idx").on(table.siteId, table.category)],
);

export const videos = pgTable(
  "videos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    youtubeId: text("youtube_id").notNull(),
    kind: text("kind", { enum: ["front_view", "360_view", "walkthrough", "other"] })
      .notNull()
      .default("other"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("videos_site_idx").on(table.siteId)],
);

/** No rows for a user means "every published site of my client". */
export const userSiteGrants = pgTable(
  "user_site_grants",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.siteId] })],
);

export const accessLog = pgTable("access_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
  event: text("event").notNull(),
  target: text("target"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accessChanges = pgTable("access_changes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  subject: text("subject").notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
