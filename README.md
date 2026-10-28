# Pichani — Supabase-connected frontend

This package preserves the Pichani dashboard styling and connects its account, album, and photo-library flows to the Supabase project.

## Project configuration
- Supabase project: `mnhdrwkmnnslhtbypjxw`
- URL and publishable key are in `supabase-config.js`.
- That file contains a frontend-safe publishable key only. Never add a Supabase service-role or secret key to frontend files.

## Run locally
This is a static HTML/CSS/JavaScript project. Serve the folder through a local HTTP server (not by opening `index.html` as a `file://` URL), or deploy it to a static host over HTTPS. For example, from this folder run `python -m http.server 8000` and open `http://localhost:8000`. Configure the matching URL in Supabase Authentication > URL Configuration, including the local URL and your eventual deployed site URL.

## Connected features
- Email/password sign-up, sign-in, sign-out, and password reset email.
- Fetches the signed-in user's private photo metadata and albums.
- Uploads accepted images to the private `pichani-photos` Storage bucket and records metadata in `public.photos`.
- Uses expiring signed URLs for private photo display (signed in batches and cached until shortly before they expire).
- Photo viewer with favourite, download and delete; a Favourites page that lists favourited photos.
- Password-recovery flow: the emailed link opens a "Choose a new password" form.
- Library queries page through results, so libraries over 1,000 photos load completely.
- Creates albums, updates favourite flags, and shows photo count/storage usage.
- Checks the free-plan limits in the browser before upload: 1,500 photos, 5 GiB, and 50 MiB per file.

## Important pre-launch requirements
1. **This is an integration build, not a production-certified release.** Test sign-up, confirmation email, sign-in, password reset, uploads, deletion, and access isolation using two separate test accounts.
2. The database metadata quota trigger does not itself prevent a malicious client from uploading raw objects directly to Supabase Storage. Before public launch, implement a server-side/Edge Function upload workflow that checks quotas atomically, reconciles orphaned objects, and validates file type/content. Browser-side checks are usability checks, not a security boundary.
3. Configure Supabase Auth redirect URLs and email templates. If email confirmation is enabled, users need to confirm before they can sign in.
4. Current frontend uses email/password. Social sign-in, album photo assignment UI, export, sharing, payments, and profile editing are not implemented.
5. Current album cards use a decorative sample cover image; albums and their names/counts are fetched from the database. The recent-photo preview uses actual uploaded photos.
6. Free plan copy is 5 GiB or 1,500 photos, whichever is reached first. Database quota and UI limits must stay aligned.
7. Confirm database RLS/storage policies and Data API permissions before production. Configure independent backups and test restore before making long-term preservation promises.
8. Keep the publishable key public only as intended; never expose service-role/secret keys. Add your final production domain to Supabase Auth redirect settings before launch.

## Files
- `index.html` — dashboard and dialogs
- `styles.css` — existing responsive Pichani design plus auth styles
- `script.js` — Supabase auth, photo, album, and UI logic
- `supabase-config.js` — frontend-safe project URL/key
- `supabase-hardening.sql` — RLS/storage audit queries, bucket limits and delete policies (run the audit section first)
