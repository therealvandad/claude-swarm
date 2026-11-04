const ADJ = ["brave", "calm", "swift", "quiet", "bold", "keen", "merry", "sly", "wise", "lucky",
  "nimble", "proud", "gentle", "fierce", "clever", "sunny", "amber", "misty", "rapid", "steady"];
const ANIMAL = ["fox", "owl", "otter", "lynx", "hare", "wolf", "heron", "bear", "crane", "moth",
  "finch", "seal", "newt", "ibis", "yak", "wren", "panda", "koala", "gecko", "raven"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
module.exports = function randomName() {
  return `${pick(ADJ)}-${pick(ANIMAL)}`;
};
