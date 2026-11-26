import test from "node:test";
import assert from "node:assert/strict";

process.env.APP_BASE_URL = "https://paceup.example";
process.env.PACEUP_TIMEZONE = "Asia/Kolkata";
const { ridePublishedText, riderListText, shortName } = await import("../src/whatsapp/messages.js");

const ride = {
  title: "Pathways ride", category: "cycling", starts_at: "2026-11-21T00:15:00Z", meeting_point: "Xavier's", map_url: "https://maps.app.goo.gl/a",
  meeting_point_2: "Tulip Chowk", meeting_at_2: "2026-11-21T00:30:00Z", map_url_2: "https://maps.app.goo.gl/b",
  distance_km: 35, club_name: "Sunrise Club", organiser_name: "Amit Daga", organiser_id: "u1", share_code: "abc123"
};

test("with a midway point, both points show with their times and the list is grouped by where people join", () => {
  const riders = [
    { id: "u1", user_id: "u1", name: "Amit Daga", join_point: 1 },
    { id: "r2", name: "Nandini Rao", join_point: 2 },
    { id: "r3", name: "Anurag Mehta", join_point: 1 }
  ];
  const text = riderListText(ride, riders, riders.slice(0, 2));
  assert.match(text, /\nSat 21 Nov\n📍 Xavier's · 5:45 AM\n🗺️ https:\/\/maps\.app\.goo\.gl\/a\n📍 Tulip Chowk · 6:00 AM\n🗺️ https:\/\/maps\.app\.goo\.gl\/b\n35 km\n/);
  assert.match(text, /\*3 going\*\n\*Xavier's · 5:45 AM \(2\)\*\n1\. Amit D\. \(lead\)\n2\. Anurag M\. 🆕\n\*Tulip Chowk · 6:00 AM \(1\)\*\n3\. Nandini R\.\n\nNo need to copy\/paste this list, it updates itself\.\n\n\*Note: Helmets[^\n]+\*$/);
});

test("without a midway point the post is unchanged", () => {
  const plain = { ...ride, meeting_point_2: null, meeting_at_2: null, map_url_2: null };
  const text = ridePublishedText(plain, [{ id: "u1", user_id: "u1", name: "Amit Daga", join_point: 1 }]);
  assert.match(text, /\nSat 21 Nov · 5:45 AM\n📍 Xavier's\n🗺️ https:\/\/maps\.app\.goo\.gl\/a\n35 km\n/);
  assert.match(text, /\*1 going\*\n1\. Amit D\. \(lead\)\n\nNo need to copy\/paste this list, it updates itself\.\n\n\*Note: Helmets[^\n]+\*$/);
  assert.match(text, /\n👇 \*Tap the link to join\.\*\nhttps:/);
  assert.doesNotMatch(text, /Tulip/);
});

test("short names skip titles saved before the name", () => {
  assert.equal(shortName("Gaurav Luthra"), "Gaurav L.");
  assert.equal(shortName("Dr Ankit Bhartia"), "Ankit B.");
  assert.equal(shortName("Mr. Naresh Dabas"), "Naresh D.");
  assert.equal(shortName("Dr Nikunj Gupta,"), "Nikunj G.");
  assert.equal(shortName("Amit"), "Amit");
  assert.equal(shortName("Dr"), "Dr");
});

test("a cycling post shows bike and ride style on one line; other types never do", () => {
  const plain = { ...ride, meeting_point_2: null, meeting_at_2: null, map_url_2: null, bike_type: "road", ride_style: "no_drop" };
  const text = ridePublishedText(plain, []);
  assert.match(text, /\n35 km\n🚲 Road bike · No-drop\nOrganiser: Sunrise Club\n/);
  assert.match(ridePublishedText({ ...plain, bike_type: null, ride_style: "drafting" }, []), /\n🚲 Drafting\n/);
  assert.match(text, /updates itself\.\n\n\*Note: Helmets, spare tube, front and back lights compulsory\. Hydration, nutrition and some cash suggested\.\*$/, "safety note is the last line of every cycling post");
  assert.doesNotMatch(ridePublishedText({ ...plain, category: "running" }, []), /Helmets/);
  assert.doesNotMatch(ridePublishedText({ ...plain, category: "running" }, []), /🚲/);
  assert.doesNotMatch(ridePublishedText({ ...plain, bike_type: null, ride_style: null }, []), /🚲/);
});
