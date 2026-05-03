```
       ,--.
      ()--()
       '--'          B O O K   L E N S
      /    \        point · capture · understand
     /______\
```

**BookLens** turns a messy pile of spines into answers: aim your camera (or drop a photo), and it tries to name the book, pull in Open Library / Wikipedia context, and let **Claude** riff on what you are holding. It all runs in the browser, and your API key stays local.

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
- An **[Anthropic API key](https://console.anthropic.com/settings/keys)** for the AI bits; paste it in **Settings** inside the app.

That’s the whole stack. Have fun shelf-diving.
