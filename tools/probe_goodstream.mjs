// Probe hlswish embed
const url = 'https://hlswish.com/e/wdw0ku6ec7oj';
const res = await fetch(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://hlswish.com/',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  }
});
console.log('Status:', res.status);
const html = await res.text();
console.log('First 2000 chars:');
console.log(html.substring(0, 2000));
const m3u8 = html.match(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/g) || [];
console.log('\nM3U8 found:', m3u8.slice(0, 5));
const packed = html.match(/eval\(function\(p,a,c,k,e/);
console.log('Has Dean Edwards packer:', !!packed);
