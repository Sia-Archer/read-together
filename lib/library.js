const path = require("path");
const crypto = require("crypto");
const store = require("./store");

const FILE = path.join(store.DATA_DIR, "library.json");
const STATUSES = new Set(["reading", "unread", "finished"]);

function read() {
  const saved = store.readJson(FILE, {});
  return {
    books: saved.books && typeof saved.books === "object" && !Array.isArray(saved.books) ? saved.books : {},
    groups: Array.isArray(saved.groups) ? saved.groups : [],
  };
}

function write(library) {
  store.writeJson(FILE, library);
}

function statusFor(entry, progress) {
  if (STATUSES.has(entry?.status)) return entry.status;
  return progress >= 100 ? "finished" : progress > 0 ? "reading" : "unread";
}

function updateBook(bookId, change) {
  if (!store.readManifest(bookId)) throw Object.assign(new Error("unknown book"), { status: 404 });
  const library = read();
  const previous = library.books[bookId] || {};
  if (change.status !== undefined && !STATUSES.has(change.status)) throw Object.assign(new Error("invalid status"), { status: 400 });
  if (change.removed !== undefined && typeof change.removed !== "boolean") throw Object.assign(new Error("invalid removed value"), { status: 400 });
  library.books[bookId] = { ...previous, ...(change.status === undefined ? {} : { status: change.status }), ...(change.removed === undefined ? {} : { removed: change.removed }) };
  write(library);
  return library.books[bookId];
}

function saveGroup(input) {
  const name = String(input.name || "").trim();
  if (!name || name.length > 24) throw Object.assign(new Error("分组名称应在 1 至 24 字内"), { status: 400 });
  const library = read();
  const id = input.id ? String(input.id) : `g-${crypto.randomUUID()}`;
  const old = library.groups.find(group => group.id === id);
  if (input.id && !old) throw Object.assign(new Error("unknown group"), { status: 404 });
  if (library.groups.some(group => group.id !== id && group.name === name)) throw Object.assign(new Error("分组名已存在"), { status: 409 });
  if (!Array.isArray(input.books) || input.books.some(bookId => typeof bookId !== "string" || !store.readManifest(bookId))) {
    throw Object.assign(new Error("invalid group books"), { status: 400 });
  }
  const group = { id, name, books: [...new Set(input.books)] };
  if (old) Object.assign(old, group);
  else library.groups.push(group);
  write(library);
  return group;
}

function addToGroup(bookId, groupId) {
  if (!groupId) return;
  const library = read();
  const group = library.groups.find(item => item.id === groupId);
  if (!group) throw Object.assign(new Error("unknown group"), { status: 400 });
  if (!group.books.includes(bookId)) group.books.push(bookId);
  write(library);
}

module.exports = { read, statusFor, updateBook, saveGroup, addToGroup };
