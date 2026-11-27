# Agentg resources

Agentg (`D:/PROJECT/etc/Agentg`, with its data in `%LOCALAPPDATA%/Agentg`) was the project the avatar look's characters, lines and voices came from. It is folded into GenCouncil and retired, so everything GenCouncil builds from it was copied here on 2026-11-27. The scripts in `apps/web/scripts/avatar-study/` read from this folder by default, not from Agentg.

## In git

| Path | From | Used by |
|---|---|---|
| `voice-lines/lines.json` | `Agentg/voice-lines/lines.json` | `build-lines.mjs` (event lines), `build-voices.mjs` (which recordings) |
| `voice-lines/banter.json` | `Agentg/.worktrees/새-안건-2/_integration/voice-lines/banter.json`, the 753-monologue set that never reached Agentg's main | `build-lines.mjs` (monologues, conversations) |
| `voice-lines/touch.json` | `Agentg/voice-lines/touch.json` | `import-agentg.py` (touch reactions) |
| `voice-lines/voices.json` | `Agentg/voice-lines/voices.json` | reference: the ElevenLabs voice for each character |
| `personas/` | `Agentg/personas/` | `import-agentg.py` (`personas/reactions`); the manner of speaking in `packages/server/src/meeting.ts` |
| `assets/rigs/` | `Agentg/assets/rigs/` | `import-agentg.py` (expression layers), `find-irises.py` |

`build-lines.mjs` with these files rebuilds `apps/web/src/avatar/lines.json` exactly as committed. The English and Japanese conversations are GenCouncil's own (`apps/web/scripts/avatar-study/dialogues-i18n.json`).

## Here but not in git (`.gitignore`)

Large binaries kept only on this PC. Back them up separately before Agentg is deleted.

| Path | From | Size | Used by |
|---|---|---|---|
| `voice-lines/audio/` | `Agentg/voice-lines/audio/` | 61 MB | `import-agentg.py` (recordings into `public/avatar/voice`) |
| `local/voice-lines/` | `%LOCALAPPDATA%/Agentg/voice-lines/` (`v1`, `v2`, `work`) | 191 MB | `build-voices.mjs` (`v1`) |
| `local/chibi-anim-v1/` | `%LOCALAPPDATA%/Agentg/art/chibi-anim-v1/` | 624 MB | `build-chibi.py` |
| `local/voice-design/` | `%LOCALAPPDATA%/Agentg/voice-design/` | 18 MB | reference: how the voices were designed |

## TTS

The Supertonic 3 adapter is `tools/tts/supertonic/server.py` (its venv's packages in `requirements.txt` there). The model and the venv moved to `~/.gencouncil/tts/supertonic/` (`model/`, `venv/`, `hf-cache/`), and `~/.gencouncil/server.json` (`tts.launch`) starts it from there. The server reads that file when it starts.

## Not copied

Agentg's own app (`src/`, `tools/` apart from the TTS adapter, `config/`, `runtime/`, `brains/`), its docs and experiments, and `%LOCALAPPDATA%/Agentg/art` apart from `chibi-anim-v1` (about 3 GB of earlier and experimental art that GenCouncil does not use).
