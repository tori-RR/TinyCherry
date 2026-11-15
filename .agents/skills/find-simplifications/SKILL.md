---
name: find-simplifications
description: Use when asked to find or plan Cherry Studio cleanup, simplification, refactoring, dead-code removal, duplicated state removal, unnecessary APIs, speculative generality, or library replacements.
---

# Find Simplifications

This skill finds a few strong candidates, not a deletion quota. Diagnosis and proposal work do not authorize implementation.

## Establish context

Read root instructions, relevant architecture/reference docs, and active Agent Notes. Run `pnpm change:scope --base <verified-ref>` when auditing a branch. When the user requests broad coverage, divide renderer, data systems, IPC, lifecycle services, Agent/runtime, packages/scripts, and test infrastructure into disjoint surveys.

## Evidence bar

A strong candidate has concrete cost and production evidence:

- no legitimate production consumer;
- tests or docs are the only consumers of a non-load-bearing behavior;
- two stores, caches, events, or representations mirror one authoritative fact;
- a generic API exists for one internal consumer;
- lifecycle/disposal machinery duplicates one owner or transition;
- a maintained dependency or platform API deletes implementation and dedicated tests with less residual glue;
- speculative configurability or fallback behavior has no current product owner.

Search exact symbols, wire names, config keys, paths, dynamic registration, tests, docs, and Agent Notes. A call site proves pressure, not that the API belongs at that boundary. Reject a candidate when it removes supported behavior, violates documented ownership, or merely relocates the same complexity.

## Output

Report the current consumers, proposed removal, tradeoffs, and verification for each strong candidate. Use an optional Agent Note when the reasoning is worth keeping with the project.

Report surveyed areas, evidence-backed candidates, rejected candidates worth preserving, deliberate exclusions, and checks actually run.
