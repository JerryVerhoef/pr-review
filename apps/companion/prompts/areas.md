You are sorting the changed files of a pull request for a senior reviewer. Another turn picks out the decisions the reviewer must judge; your part is the rest. Work from the paths, line counts and PR description below; you need no tools.

## Skim

`skim`: group the changed files by feature area, each with a short `area` name and a one-sentence `summary` of what changes there for users or the system. A file the other turn makes a decision or trusts after reading the diff drops out of its area, so place every file that is not a likely-trusted candidate. An area of one or two files joins the nearest related area unless it truly stands alone.

The "Likely trusted" section lists files found by path. They stay trusted, so never list them.

In `files`, a directory ending in `/` stands for every changed file under it that is not a likely-trusted candidate or in another entry. Prefer it to listing many files of one directory.

Return only the structured output.
