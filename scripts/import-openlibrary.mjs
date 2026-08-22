#!/usr/bin/env node
// Import sci-fi books from OpenLibrary into src/data/books.json.
// Usage: node scripts/import-openlibrary.mjs --genre="Space Opera" --limit=15
//        node scripts/import-openlibrary.mjs --all --dry-run

import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BOOKS_JSON_PATH = path.join(ROOT, "src/data/books.json");
const COVERS_DIR = path.join(ROOT, "src/assets/covers");
const USER_AGENT = "unearthed-shelf-import/1.0 (jessicadgaspar@gmail.com)";
const PLACEHOLDER_DESCRIPTION = "";
const PLACEHOLDER_BOOKSHOP = "https://www.google.com";
const REQUEST_DELAY_MS = 300;

const GENRE_QUERIES = {
  "Space Opera": "subject:space",
  Dystopian: "subject:dystopian",
  Cyberpunk: "subject:cyberpunk",
  "Time Travel": "subject:(time travel OR time)",
  Aliens: "subject:alien",
  Military: "subject:military",
  Robots: "subject:(robot OR artificial intelligence)",
  Apocalyptic: "subject:(apocalyptic OR post-apocalyptic)",
  "Alternate History": "subject:(alternate history OR alternate-history)",
  "Hard Sci-Fi": "subject:hard",
  Steampunk: "subject:steampunk",
};

const VALID_GENRES = Object.keys(GENRE_QUERIES);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      genre: { type: "string" },
      all: { type: "boolean", default: false },
      limit: { type: "string", default: "20" },
      query: { type: "string" },
      "max-year": { type: "string", default: "2005" },
      "dry-run": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (!values.all && !values.genre) {
    console.error("Error: pass --genre=\"<name>\" or --all\n");
    printHelp();
    process.exit(1);
  }

  if (values.genre && !VALID_GENRES.includes(values.genre)) {
    console.error(
      `Error: unknown genre "${values.genre}". Valid genres:\n  ${VALID_GENRES.join(", ")}`,
    );
    process.exit(1);
  }

  if (values.query && (values.all || !values.genre)) {
    console.error("Error: --query can only be used with a single --genre run.");
    process.exit(1);
  }

  return {
    genre: values.genre ?? null,
    all: values.all,
    limit: Number.parseInt(values.limit, 10),
    queryOverride: values.query ?? null,
    maxYear: Number.parseInt(values["max-year"], 10),
    dryRun: values["dry-run"],
    verbose: values.verbose,
  };
}

function printHelp() {
  console.log(`Import sci-fi books from OpenLibrary into src/data/books.json.

Usage:
  node scripts/import-openlibrary.mjs --genre="Space Opera" [options]
  node scripts/import-openlibrary.mjs --all [options]

Options:
  --genre="<name>"   One of: ${VALID_GENRES.join(", ")}
  --all              Run every genre above sequentially
  --limit=N          Max candidate works to consider per genre (default 20)
  --query=<raw>      Override the mapped subject query (single-genre runs only)
  --max-year=2005    Only include books first published on/before this year (default 2005)
  --dry-run          Fetch and log candidates without writing books.json or downloading covers
  --verbose          Extra per-book logging
  -h, --help         Show this help
`);
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueSlug(baseSlug, existingSlugs) {
  let slug = baseSlug;
  let suffix = 2;
  while (existingSlugs.has(slug)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

function normalizeDescription(description) {
  if (!description) return null;
  if (typeof description === "string") return description;
  if (typeof description === "object" && typeof description.value === "string") {
    return description.value;
  }
  return null;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function fetchSearchResults(query, limit) {
  const q = `subject:"science fiction" AND (${query})`;
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set(
    "fields",
    "title,author_name,first_publish_year,cover_i,key",
  );
  return fetchJson(url.toString());
}

async function fetchWorkDescription(workKey) {
  const data = await fetchJson(`https://openlibrary.org${workKey}.json`);
  return normalizeDescription(data.description);
}

async function downloadCover(coverId, destPath) {
  const response = await fetch(
    `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`,
    { headers: { "User-Agent": USER_AGENT } },
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} downloading cover ${coverId}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destPath, buffer);
}

async function importGenre(genre, opts, state) {
  const query = opts.queryOverride ?? GENRE_QUERIES[genre];
  console.log(`\n=== ${genre} (query: ${query}) ===`);

  const stats = { added: 0, dupe: 0, noCover: 0, badYear: 0, error: 0 };

  let results;
  try {
    results = await fetchSearchResults(query, opts.limit);
  } catch (err) {
    console.warn(`[warn] search failed for "${genre}": ${err.message}`);
    return stats;
  }

  console.log(
    `  numFound=${results.numFound} — considering ${results.docs.length} candidate(s)`,
  );
  if (results.numFound === 0) {
    console.warn(`[warn] "${genre}" query returned zero results — mapping may need --query override`);
  }

  for (const doc of results.docs) {
    await sleep(REQUEST_DELAY_MS);

    if (!doc.first_publish_year || doc.first_publish_year > opts.maxYear) {
      stats.badYear += 1;
      if (opts.verbose) console.log(`  [skip:year] ${doc.title}`);
      continue;
    }

    if (!doc.cover_i) {
      stats.noCover += 1;
      if (opts.verbose) console.log(`  [skip:no-cover] ${doc.title}`);
      continue;
    }

    const author = doc.author_name?.[0] ?? "Unknown";
    if (!doc.author_name?.[0]) {
      console.warn(`[warn] "${doc.title}" has no listed author — using "Unknown"`);
    }

    const dedupeKey = `${doc.title.toLowerCase()}|${author.toLowerCase()}`;
    const baseSlug = slugify(doc.title);
    if (state.existingKeys.has(dedupeKey) || state.existingSlugs.has(baseSlug)) {
      stats.dupe += 1;
      if (opts.verbose) console.log(`  [skip:dupe] ${doc.title}`);
      continue;
    }

    let description = PLACEHOLDER_DESCRIPTION;
    try {
      description = (await fetchWorkDescription(doc.key)) ?? PLACEHOLDER_DESCRIPTION;
    } catch (err) {
      console.warn(`[warn] description fetch failed for "${doc.title}": ${err.message}`);
    }

    const id = String(state.nextId);
    const slug = uniqueSlug(baseSlug, state.existingSlugs);

    const book = {
      id,
      slug,
      title: doc.title,
      author,
      rating: "0",
      genre,
      description,
      year: String(doc.first_publish_year),
      goodreads: `https://www.goodreads.com/search?q=${encodeURIComponent(`${doc.title} ${author}`)}`,
      bookshop: PLACEHOLDER_BOOKSHOP,
      cover: `../assets/covers/${id}.jpg`,
    };

    if (!opts.dryRun) {
      try {
        await downloadCover(doc.cover_i, path.join(COVERS_DIR, `${id}.jpg`));
      } catch (err) {
        stats.error += 1;
        console.warn(`[warn] cover download failed for "${doc.title}": ${err.message} — skipping book`);
        continue;
      }
    }

    console.log(`  [add] #${id} "${doc.title}" by ${author} (${doc.first_publish_year})`);
    state.existingSlugs.add(slug);
    state.existingKeys.add(dedupeKey);
    state.nextId += 1;
    state.newBooks.push(book);
    stats.added += 1;
  }

  return stats;
}

async function main() {
  const opts = parseCliArgs();

  let existingBooks;
  try {
    existingBooks = JSON.parse(await readFile(BOOKS_JSON_PATH, "utf-8"));
  } catch (err) {
    console.error(`Fatal: could not read/parse ${BOOKS_JSON_PATH}: ${err.message}`);
    process.exit(1);
  }

  const state = {
    existingSlugs: new Set(existingBooks.map((b) => b.slug)),
    existingKeys: new Set(
      existingBooks.map((b) => `${b.title.toLowerCase()}|${b.author.toLowerCase()}`),
    ),
    nextId: Math.max(...existingBooks.map((b) => Number(b.id))) + 1,
    newBooks: [],
  };

  const genres = opts.all ? VALID_GENRES : [opts.genre];
  const statsByGenre = {};

  for (const genre of genres) {
    statsByGenre[genre] = await importGenre(genre, opts, state);
  }

  if (!opts.dryRun && state.newBooks.length > 0) {
    const merged = [...existingBooks, ...state.newBooks];
    await writeFile(BOOKS_JSON_PATH, JSON.stringify(merged, null, 4) + "\n", "utf-8");
  }

  console.log("\n=== Summary ===");
  for (const [genre, stats] of Object.entries(statsByGenre)) {
    console.log(
      `${genre}: added=${stats.added} dupe=${stats.dupe} noCover=${stats.noCover} badYear=${stats.badYear} error=${stats.error}`,
    );
  }
  if (opts.dryRun) {
    console.log("\n(dry run — nothing written)");
  } else if (state.newBooks.length > 0) {
    console.log(
      `\nAdded ${state.newBooks.length} book(s): ids ${state.newBooks.map((b) => b.id).join(", ")}`,
    );
    console.log(
      "Reminder: rating, bookshop, and goodreads are placeholders — update them via the CMS.",
    );
  } else {
    console.log("\nNo new books added.");
  }
}

main();
