# Security Summary

## Audit Overview & Secret Finding (`firebase-applet-config.json`)
- **Detected Credential (`firebase-applet-config.json`, Line 4, Commit `86300d36`)**: Verified to be the public **Firebase Web API Key** for Firebase project `grand-gizmo-3v0ns` (`appId: 1:649094823665:web:0af1372a3676e675597350`). It is **not** a Gemini Developer API Key (`@google/genai` is unused in both client and server code) and **not** a service account or Bunny Stream private credential.
- **Git & History Scan**: Full repository and commit-history checks found zero leaked Google/Firebase Admin service account JSON files, zero Gemini API keys, zero Bunny Stream API keys, zero PEM private keys, and zero committed `google-services.json` files (`.gitignore` properly excludes `google-services.json`, `.env`, `data/database.json`, and `*.keystore`).
- **Google Cloud Key Restrictions (Manual Action Required)**: Limiting this Firebase Web API Key strictly to Firebase-required APIs (Identity Toolkit, Token Service, Firestore, Realtime Database, Firebase Storage, Firebase Installations) and adding Android package / web referrer restrictions must be configured and verified directly in Google Cloud Console before dismissing the GitHub secret-scanning alert.

## Key Security Fixes Implemented
1. **User Account Isolation on Profile & Watch History APIs (`/api/user/*`)**:
   - **Before**: Unauthenticated requests targeting any user ID (including signed-in Firebase UIDs) bypassed Bearer token verification whenever no `Authorization` header was supplied.
   - **After**: `authorizeUserRequest` in `server.ts` enforces strict Firebase ID Token verification (`decoded.uid === targetUid`) for all non-guest UIDs and for any profile linked with Firebase Auth (`authVerified: true`), returning HTTP `401`/`403` otherwise while preserving anonymous guest device profiles (`yg_*`).
2. **Pre-Auth File Upload & Stored HTML/SVG XSS Prevention (`/api/user/profile-picture`, `/api/upload`, `/api/upload-chunk`, `/uploads`)**:
   - **Before**: `POST /api/user/profile-picture` wrote uploaded files to `data/uploads/` before verifying account ownership or validating file headers/extensions, and `/uploads` served files without `X-Content-Type-Options: nosniff` or non-media disposition protection.
   - **After**: Avatar uploads buffer in memory (capped at 2 MB), verify user authorization before writing to disk, check both MIME type and image file magic bytes (PNG, JPEG, WebP, GIF only), and generate random hex filenames. Admin media and chunk uploads enforce explicit video/image/subtitle extension allowlists, and `/uploads` sets `X-Content-Type-Options: nosniff` plus `Content-Disposition: attachment` for any non-media extension.
3. **Explicit Field Whitelisting on Admin Anime Updates (`PUT /api/admin/anime/:id`)**:
   - Replaced raw request body object spreads with explicit sanitized field picking so arbitrary fields cannot be injected into stored catalog records.
4. **Admin RBAC & Database Rules Verification**:
   - Backend admin routes remain protected by `verifyAdminAuth` (Firebase ID Token signature verification + `xyronbhaiii@gmail.com` + `email_verified === true` check).
   - `firestore.rules`, `database.rules.json`, and `storage.rules` enforce owner-only admin writes and `request.auth.uid == userId` user isolation (`npx eslint firestore.rules` passes with zero errors).

---

## PoC Verification

### Proof-of-Concept 1 — Unauthenticated Profile Picture Disk Write & Stored Active Content
- **Issue**: Prior to the fix, sending a `multipart/form-data` upload containing a `.html` or `.svg` file to `POST /api/user/profile-picture` with any arbitrary `userId` wrote the raw file directly into `data/uploads/` before `validateBearerUidIfPresent` ran and allowed same-origin rendering via `/uploads/<file>`.
- **Fix Verified**:
  - `avatarUpload` buffers files in memory (`2 MB` cap), `authorizeUserRequest` rejects unauthenticated Firebase UIDs with HTTP `401` before any disk I/O occurs, and `isValidAvatarMagicBytes` + `SAFE_IMAGE_MIMES` reject non-raster payloads (such as `.html` or `.svg`) with HTTP `400`.
  - `/uploads` sets `X-Content-Type-Options: nosniff` and forces `Content-Disposition: attachment` + `application/octet-stream` for non-media extensions.

### Proof-of-Concept 2 — Firebase UID Account Overwrite Without Token
- **Issue**: Prior to the fix, calling `POST /api/user/profile`, `POST /api/user/watch-history`, or `GET /api/user/profile` with a signed-in user's Firebase UID (`userId=<firebaseUid>`) and no `Authorization` header succeeded because `validateBearerUidIfPresent` returned `true` when the header was absent.
- **Fix Verified**:
  - Calling `/api/user/profile` or `/api/user/watch-history` with a Firebase UID and no Bearer token now returns HTTP `401` (`Authentication required for signed-in user accounts`).
  - Calling with a mismatched Bearer token returns HTTP `403`.
  - Guest device UIDs (`yg_<timestamp>_<hex>`) continue working without interruption until upgraded with `authVerified: true`.

### Proof-of-Concept 3 — Admin Endpoint Protection & HLS Inspector SSRF Guard
- Unauthenticated calls to `GET /api/admin/stats`, `POST /api/admin/anime`, and `POST /api/admin/episodes` are rejected with HTTP `401`.
- Calls to `GET /api/stream/hls-inspect` targeting localhost or private IPs (`127.0.0.1`, `169.254.169.254`, `http://` schemes) are rejected with HTTP `400`.
