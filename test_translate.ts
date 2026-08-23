const text = "This is a test description. (Source: ANN)";
const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=${encodeURIComponent(text)}`);
const json = await res.json();
console.log(json[0].map((x: any) => x[0]).join(""));
