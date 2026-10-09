# JCM-Tools

A multi-tool suite (CRM + Quotation Generator + Order Planning) for electrical/electronic project leads, built with vanilla JS + Vite and Supabase.

## Features

- Project pipeline (New Lead → Store Visited → Quotation Given → Project Final/Partial Won/Project Lost) with search, status filter, and city filter
- Architect tracking (pick a previously used architect, "Unknown", or add a new one) and a multi-select product stage checklist (Conduit, Wiring, Lights, Switches, Fans, Decoratives, Appliances)
- Follow-up notes per project
- Photo gallery per project (upload/delete, stored in Supabase Storage)
- One-tap Call and WhatsApp buttons wherever a phone number is on screen
- Admin page to view the team and manage roles (admin/staff) and account access

## Setup

```
npm install
npm run dev
```

### Database setup (one-time)

The photo gallery and admin user management features need two things added to your Supabase project that
aren't created automatically by the app:

1. Open your Supabase project → **SQL Editor** → New query.
2. Paste in the contents of [`supabase/setup.sql`](supabase/setup.sql) and run it.

This creates:

- `project_photos` table + a public `project-photos` storage bucket, for the photo gallery.
- `profiles` table (email, role, active) + a trigger that auto-creates a profile whenever someone signs up, for
  the admin page.
- `architect`, `whatsapp`, `address`, and `product_stages` columns on `projects`, for the project form.

The script is safe to re-run any time it's updated — every statement is guarded so it only fills in what's
missing instead of failing on what already exists.

The script promotes `jcmretails@gmail.com` to `admin` — edit that line first if a different account should be
the first admin. Everyone else defaults to `staff`; promote more admins from the **Manage users** page once
you're signed in as one.

New logins are created from your Supabase project's **Authentication** tab (there's no public sign-up flow in
the app) — they'll appear on the **Manage users** page automatically after their first sign-in.
