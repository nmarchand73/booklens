```
       ,--.
      ()--()
       '--'          B O O K   L E N S
      /    \        point · capture · understand
     /______\
```

**BookLens** turns a messy pile of spines into answers: aim your camera (or drop a photo), and it tries to name the book, pull in Open Library / Wikipedia context, and let a **vision-capable LLM** riff on what you are holding. It all runs in the browser, and your API key stays local (**BYOK** — bring your own key).

No install drama, no bundler: plain **HTML, CSS, and JS**. Good for a quick demo on your laptop or a static host.

---

## Run it

From this folder:

```bash
python -m http.server 8080
```

Open **http://localhost:8080** — any static file server works the same way.

---

## What you need

- A modern browser with camera access (or use a file upload if you prefer).
- In **Settings**, choose a provider and paste the matching API key:
  - **[Anthropic](https://console.anthropic.com/settings/keys)** (Claude) — recommended default; browser calls are explicitly allowed by Anthropic for this API.
  - **[OpenAI](https://platform.openai.com/api-keys)** (e.g. GPT-4o / GPT-4o mini) — **CORS**: some browsers block `https://api.openai.com` from `file://` or certain static origins. If requests fail, serve this folder over **http://localhost** (as above) or use your own tiny proxy.
  - **[Google AI Studio](https://aistudio.google.com/apikey)** (Gemini) — key in the URL query for `generateContent`; keep the page on HTTPS or localhost in production habits.

Model names are persisted **per provider** in `localStorage` (`bl_provider`, `bl_key`, `bl_model_<provider>`).

That’s the whole stack. Have fun shelf-diving.
