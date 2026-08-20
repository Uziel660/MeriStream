const text = "This is a <a href='https://example.com'>link</a>. And this is <br/> a break.";
console.log(text.replace(/<[^>]+>/g, ""));
