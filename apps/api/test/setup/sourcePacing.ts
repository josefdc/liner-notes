// Tests do not pace Discogs, SecondHandSongs and Deezer requests: they answer from stubs at once.
// A test of the pacing turns it on (setUnpacedForTests(false)) and off again.
import { setUnpacedForTests } from "../../src/sources/pacing.js";

setUnpacedForTests(true);
