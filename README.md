# ZapShift Backend

ZapShift backend is the API layer for a parcel delivery platform. It handles user management, parcel creation and tracking, rider workflows, payment processing, and admin operations.

## Overview

- Built with **Express.js** and **Node.js**
- Uses **MongoDB** for data storage
- Verifies Firebase ID tokens for protected routes
- Integrates with **Stripe** for checkout sessions
- Deployed with **Vercel** using the configuration in [vercel.json](vercel.json)

## Tech Stack

- `express` — REST API server
- `cors` — cross-origin request support
- `dotenv` — environment variable loading
- `firebase-admin` — backend Firebase token verification
- `mongodb` — database access
- `stripe` — payment session creation and verification

## Project Structure

- [index.js](index.js) — main server entry point and all API routes
- [package.json](package.json) — scripts and dependencies
- [vercel.json](vercel.json) — deployment config for Vercel
- [.env](.env) — local environment variables (not committed in some setups)

## Installation

1. Go to the backend folder:
   ```bash
   cd backend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file with the required variables.
4. Start the server:
   ```bash
   npm run dev
   ```

## Required Environment Variables

| Variable | Purpose |
|---|---|
| `DB_URI` | MongoDB connection string |
| `PORT` | Server port (defaults to `4000`) |
| `STRIPE_SECRET_KEY` | Stripe API secret |
| `SITE_DOMAIN` | Frontend base URL used in payment callbacks |
| `FB_SERVICE_KEY` | Base64-encoded Firebase service account JSON |

## Core Features

### Authentication and Authorization

- `verifyFBToken` checks the Firebase bearer token on protected endpoints.
- `verifyAdmin` checks whether the authenticated user has the `admin` role.

### Database Collections

The API uses these MongoDB collections:

- `users`
- `parcels`
- `payments`
- `riders`
- `trackings`

## API Route Summary

### Root

- `GET /` — health check response

### Users

- `GET /users` — fetch all users or a user by email
- `GET /users/:id` — fetch a single user
- `GET /users/:email/role` — fetch role for a user
- `PATCH /users/:id` — update role (admin only)
- `PATCH /users/profile/:id` — update profile info
- `POST /users` — create user record
- `DELETE /users/:id` — delete user

### Parcels

- `GET /parcels` — fetch parcels with optional search/filter/pagination
- `GET /admin/parcels` — admin-only parcel listing
- `GET /parcels/rider` — rider-specific assigned deliveries
- `GET /parcels/rider/completed-deliveries` — rider completed deliveries
- `GET /parcels/:id` — fetch parcel by id
- `POST /parcels` — create parcel and tracking record
- `PATCH /parcels/:id/status` — update parcel status
- `PATCH /parcels/:id` — edit parcel receiver details
- `PATCH /parcels/assign-rider/:id` — assign rider to parcel
- `PATCH /parcels/:id/request-payout` — request payout for rider
- `GET /rider-payments` — fetch rider payout data
- `DELETE /parcels/:id` — delete parcel

### Payments

- `POST /create-checkout-session` — create Stripe checkout URL
- `PATCH /payment-success` — confirm payment via Stripe session and update parcel/payment collections
- `GET /payments` — fetch payment history for the logged-in user
- `GET /admin/payments` — admin payment history

### Riders

- `GET /riders` — fetch riders with filters/search
- `PATCH /riders/:id` — approve or reject rider application
- `POST /riders` — create rider application
- `DELETE /riders/:id` — delete rider

### Tracking

- `GET /parcel-track/:trackingId` — fetch parcel details and tracking history

## Tracking Flow

When a parcel is created, the API:

1. Generates a tracking ID using the `ZAP-...` format.
2. Inserts the parcel into the `parcels` collection.
3. Stores an initial tracking event in the `trackings` collection.

## Payment Flow

1. The client sends parcel information to `/create-checkout-session`.
2. Stripe returns a checkout URL.
3. After successful payment, `/payment-success` verifies the session.
4. The backend stores payment details and updates parcel status to `pending_pickup`.

## Deployment

The server is configured for Vercel deployment in [vercel.json](vercel.json). The API routes are forwarded to the Express handler so the backend can respond to all requests.

## Notes

- The backend assumes Firebase Admin credentials are available through `FB_SERVICE_KEY`.
- For local development, make sure MongoDB and Stripe values are configured correctly.
- The API returns JSON responses and standard HTTP status codes for success, auth failure, and validation errors.
