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
  - **[OpenAI](https://platform.openai.com/api-keys)** — modèles récents type **GPT-5.4 mini / nano / 5.5** (vision + texte ; voir [choix du modèle](https://platform.openai.com/docs/models)). **CORS** : depuis `file://` ou certains hôtes statiques, le navigateur peut bloquer `api.openai.com` — servez la page en **http://localhost** ou utilisez un petit proxy.
  - **[Google AI Studio](https://aistudio.google.com/apikey)** (Gemini) — repères perf/prix sur les classements [Artificial Analysis](https://artificialanalysis.ai/) ; IDs API **Gemini 3 (preview)** ou **2.5** selon [la doc modèles](https://ai.google.dev/gemini-api/docs/models). La clé est passée en query sur `generateContent`.

Les listes déroulantes suivent ces docs (et évoluent avec les API). Pour comparer intelligence / vitesse / prix entre labos : [artificialanalysis.ai](https://artificialanalysis.ai/).

Model names are persisted **per provider** in `localStorage` (`bl_provider`, `bl_key`, `bl_model_<provider>`).

That’s the whole stack. Have fun shelf-diving.
