/**
 * Make a throwaway gPodder home for the smoke run: the unit tests' fixture
 * database, with feed and media URLs pointed at the local server. Prints the
 * home's path.
 *
 * @module
 */
import { makeHome } from "../test_support.ts";

const base = Deno.args[0];
const h = makeHome();
h.exec(
  "UPDATE podcast SET url = replace(url, 'http://feeds.test', ?)",
  `${base}/feeds`,
);
h.exec(
  "UPDATE episode SET url = replace(url, 'http://media.test', ?)",
  `${base}/media`,
);
console.log(h.home);
