# Kindred

Anonymous voice calls between people who are grieving.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000 in two browser windows to try a call.

## Turn on the Cloudflare relay (required before real users)

Without it, calls connect directly. That fails on some networks and lets a
technical user see the other person's IP address (and so roughly where they are).
With it, every call goes through Cloudflare, and neither person's address is shared.

1. Create a free account at https://dash.cloudflare.com
2. In the dashboard, open **Realtime** → **TURN Server** → **Create** (name it "Kindred").
3. Copy the **Turn Token ID** and the **API Token** it shows you. The API token is shown only once.
4. Start the server with both values:

```bash
CF_TURN_KEY_ID=your-token-id CF_TURN_API_TOKEN=your-api-token npm start
```

The server prints "Calls are relayed through Cloudflare TURN" when it's on.
Keep the API token secret: never put it in the app's public files or in git.
On a hosting service, add both as environment variables or secrets.

Cost: the first 1,000 GB a month is free (about 250,000 five-minute calls),
then $0.05 per GB.

## Where things live

| File | What it does |
|---|---|
| `server.js` | Matching, call clock, add-time votes, Cloudflare relay, reports, ratings |
| `public/index.html` | All screens, including the guide text |
| `public/app.js` | Calls, timer, guide drawer, after-call screen |
| `public/operator.js` | The one-minute operator announcement |
| `public/resources.js` | Crisis and grief helplines by country. Re-check numbers before launch |
| `public/scene.js` + `public/img/photos.json` | Background photos for each screen and their credits |
| `public/audio/operator.mp3` | Optional: a recorded operator voice (used automatically if present) |

## Testing tip

`TIME_SCALE=0.1 npm start` runs calls 10x faster (a 5-minute call takes 30 seconds).

## Photos

Every screen can show a sepia-toned background photo. Add only photos you have
confirmed are **public domain**, put the file in `public/img/`, and list it in
`public/img/photos.json` with its title, photographer, date, source link and license.
The "Photo credits" link on the first screen appears automatically.
The format is described at the top of `public/scene.js`.

## Fonts

Stored in `public/fonts/` so no request goes to Google (keeps users anonymous).
Playfair Display and Lora: SIL Open Font License. Special Elite: Apache License 2.0.
