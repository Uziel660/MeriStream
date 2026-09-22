import { enrichUniversalMetadata } from '../server/metadataEngine';

async function check() {
  const titles = [
    'Testamentthestoryofmoses',
    'Unicotestigo',
    'Testigoprotegido',
    'Eltestamentodelaabuela',
    'Bakatotesttoshoukanjuu'
  ];
  
  for (const t of titles) {
    console.log(`\nTesting: ${t}`);
    const meta = await enrichUniversalMetadata(t);
    console.log(`-> ${meta?.title}`);
  }
}
check();
