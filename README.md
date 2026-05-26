# PS99 Sniper

A small local web app for checking Pet Simulator 99 RAP values, price history, future value estimates, and Roblox public servers.

## Run

```bash
npm start
```

Open `http://localhost:3055`.

## Optional AI model setup

The value assistant works without a model, but it can also use Ollama or NVIDIA for cleaner replies.

Ollama:

```bash
ollama serve
ollama pull llama3.1
set OLLAMA_MODEL=llama3.1
```

NVIDIA:

```bash
set NVIDIA_API_KEY=your_key_here
set NVIDIA_MODEL=meta/llama-3.1-8b-instruct
```

For the hosted website, set `NVIDIA_API_KEY` in the host's environment variables or secrets panel. Do not put it in `public/app.js` or commit it to GitHub.

Render deploy:

1. Connect this repo to Render as a Web Service.
2. Use the included `render.yaml`.
3. Add `NVIDIA_API_KEY` as a secret environment variable in Render.
4. Deploy.

Provider options:

```bash
set ASSISTANT_MODEL_PROVIDER=auto
```

Use `auto`, `ollama`, `nvidia`, or `rules`. Do not put API keys in the code.

## Notes

The app uses public Roblox server data, BIG Games RAP data, and PS99RAP history data when those services are reachable.
