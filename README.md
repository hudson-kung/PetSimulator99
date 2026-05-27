# Pet Simulator Tools

A small web app for checking Pet Simulator RAP values, price history, future value estimates, and Roblox public servers.

## Run

```bash
npm start
```

Open `http://localhost:3055`.

## Optional AI model setup

The value assistant works without a model, but it can also use a local Ollama model for cleaner replies.

```bash
ollama serve
ollama pull llama3.1
set OLLAMA_MODEL=llama3.1
```

Render deploy:

1. Connect this repo to Render as a Web Service.
2. Use the included `render.yaml`.
3. Deploy.

Provider options:

```bash
set ASSISTANT_MODEL_PROVIDER=auto
```

Use `auto`, `ollama`, or `rules`. Do not put API keys in the code.

## Notes

The app uses public Roblox server data, BIG Games RAP data, and PS99RAP history data when those services are reachable.
