const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { parseEpub } = require('../lib/epub');

test('imports EPUB title, author and chapter text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'books-epub-test-'));
  try {
    const zip = new AdmZip();
    zip.addFile('META-INF/container.xml', Buffer.from('<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>'));
    zip.addFile('OEBPS/book.opf', Buffer.from('<?xml version="1.0"?><package><metadata><dc:title>示例书</dc:title><dc:creator>示例作者</dc:creator></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'));
    zip.addFile('OEBPS/chapter.xhtml', Buffer.from('<html><body><h1>第一章</h1><p>一段用于测试的文字。</p></body></html>'));
    const file = path.join(dir, 'sample.epub');
    zip.writeZip(file);
    const book = parseEpub(file);
    assert.equal(book.metadata.title, '示例书');
    assert.equal(book.metadata.author, '示例作者');
    assert.match(book.sections.map(section => section.text).join('\n'), /一段用于测试的文字/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
