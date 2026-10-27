# beddari swamp extensions

[swamp](https://github.com/swamp-club/swamp) extensions published under the
`@beddari` collective. Each extension lives in its own directory with its own
manifest, README, license and swamp repository marker, and is published
independently:

| Directory  | Extension          | What it covers                                                                                                                           |
| ---------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `gpodder/` | `@beddari/gpodder` | A gPodder library as data, and new downloads to notes: whisper.cpp transcripts, Claude summaries and chapters, Markdown export, listening audit, feed health |

Develop against a swamp repository by loading every extension from source:

```sh
swamp extension source add ~/kode/beddari/swamp-extensions/*
```

Publish one extension from its directory. The adversarial review report that
`swamp extension push` checks lives in the extension's own `.review/`, so it is
committed with the release and survives any machine; the dry run prints the
report's exact path there:

```sh
cd gpodder && export SWAMP_EXTENSION_REVIEW_DIR=$PWD/.review
swamp extension push manifest.yaml --dry-run
```
