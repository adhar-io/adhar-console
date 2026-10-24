---
title: Retrieval and knowledge grounding
category: AI & MCP
summary: Answer from the platform's own docs, repos and incident notes — cite them — and let people correct what the model retrieves.
tools: [Qdrant, Neo4j, CloudNativePG, Adhar AI]
order: 60
---

## Why
A model knows the internet as of its training date, not your platform as of this morning. Retrieval-augmented generation (RAG) finds the relevant passages first and puts them in the prompt, so answers are current, specific, and checkable against a source.

## How Adhar does it
The Adhar AI runtime keeps a knowledge base:
- **Sources:** the platform's docs, examples, changelog and CLI reference (a bundle versioned with the release), the `packages` and `environments` repos in Gitea, and notes people add.
- **Stores:** vectors in Qdrant (collection `adhar_knowledge`, created by a `Vector` claim), relationships in Neo4j, runtime state in a CloudNativePG database.
- **Freshness:** an in-process refresh every 30 minutes plus the nightly CronJob `adhar-ai-knowledge-reindex`. Re-indexing is incremental — unchanged content isn't re-embedded.
- **People in the loop.** Keeping an answer adds it as a note (`create ai-knowledge`); a thumbs-down on its sources re-ranks them (`update ai-knowledge`). Both are granted to every signed-in member by default.

## Use it
1. In [Adhar AI](/ai), type `/knowledge <topic>` to see what it would retrieve.
2. After an incident, keep the answer that explains it — it's searchable at once.
3. Need your own store? Create a `Vector` claim in [Platform → Vector stores](/platform?section=vector-stores).

## Watch out
- Retrieved text is untrusted input; it can carry instructions — see [Prompt-injection defences](/help?pattern=prompt-injection-defences).
- Shared notes reach everyone's answers; restrict `create ai-knowledge` if that is too open for you.
- Wrong sources produce confident wrong answers; vote them down.
