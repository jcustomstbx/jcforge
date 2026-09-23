# JCForge Setup — Streamlabs

## 1. Install

Run the installer. Open JCForge.

A 24-hour free trial starts automatically the first time you open it. No key needed.

When the trial ends, JCForge shows a lock screen. If you were sent a license key, paste it in there and it unlocks. Keys can have an end date, so check when yours expires.

## 2. Point it at Streamlabs

In JCForge, go to **Sources**. Click **Streamlabs**.

In Streamlabs Desktop: **Settings → Mobile**. Copy the token shown there.
(Not "Remote Control" — Streamlabs moved it and their own help docs still say the old location.)

Paste that token into JCForge's Streamlabs box. Click Save.

## 3. Set the replay folder

In Streamlabs, check where your replay buffer saves clips to (Settings → Output, or wherever you set it up).

Paste that same folder path into JCForge's "replay buffer output folder" box. Click Save.

## 4. Twitch chat (optional)

If you want JCForge to use chat activity for detecting hype moments, enter your Twitch channel name on the same Sources screen. Not required.

## 5. Start streaming

Start your stream and replay buffer in Streamlabs as normal.

JCForge watches in the background and saves a clip automatically when it detects an exciting moment. You can also press **F9** any time to save a clip manually.

## 6. Find your clips

Go to **Clip Library** in JCForge to see everything it saved.

## 7. AI Editor (optional)

The **AI Edit** screen can turn a raw clip into a captioned short. Read `AI_EDITOR_NOTICE.md` before touching this — it needs your own API key, and it's still rough around the edges.

---

Something not working? Check:
- Streamlabs Desktop is actually open and the token is pasted correctly.
- The replay folder path is exact and Streamlabs is really saving there.
- Streamlabs' replay buffer is turned on, not just recording.
