# Grainora — Complete Rice Mill Management System

Full-stack project with separate frontend and backend.

## Stack
- Frontend: HTML, CSS, JavaScript
- Backend: Node.js, Express REST API
- Database: SQLite (`grainora.db` is created automatically)

## Run locally
1. Install Node.js 22.13 or newer (the backend uses Node.js built-in SQLite; no Visual Studio C++ Build Tools are required).
2. Extract this folder and open it in VS Code.
3. Open terminal in the `grainora-complete` root folder.
4. Run:
   ```bash
   npm install
   npm start
   ```
5. Open http://localhost:3000
6. API health check: http://localhost:3000/api/health

The Express server serves the frontend and API from the same origin, so the frontend API config works locally without extra setup.

## Included modules
Dashboard, Farmer Management, Paddy Purchase, Production, Stock Management, Sales & Billing, Customers, Expenses, Reports.

## Data
SQLite database is stored in `grainora.db` at the project root. It is ignored by Git so local business records are not committed.

## Important notes
- This is a college project starter, not production-ready business software.
- There is no login/authentication yet. Do not expose it publicly with real personal/business data until authentication and security controls are added.
- The profit report is an estimate (sales less recorded expenses) and excludes cost of goods sold, inventory valuation and other accounting adjustments.
- GitHub Pages cannot host Node.js. For public deployment, host the Node backend on a Node-capable service and configure `public/config.js` with that backend's base URL, or use a single Node hosting service for both frontend and API.


## Public deployment (frontend + backend together)

This app serves the website and `/api` from the same Express service. `public/config.js` uses a relative API path, so the deployed frontend calls the deployed backend on the same domain.

### Render setup
1. Push the contents of this `grainora-complete` folder to a GitHub repository (so `package.json` is at the repository root).
2. In Render, create **New → Web Service**, connect that repository, and use:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Runtime: Node
3. Deploy, then open the `onrender.com` URL Render provides. Check `<your-url>/api/health` to verify the API.

### Database persistence warning
This project uses a local SQLite database. Render's free web services have an ephemeral filesystem, so database changes may be lost on restart, sleep, or redeploy. For persistent data, attach a paid persistent disk and set `DB_PATH` to a path inside its mount (for example `/var/data/grainora.db` if the disk is mounted at `/var/data`), or migrate the app to a managed database.
