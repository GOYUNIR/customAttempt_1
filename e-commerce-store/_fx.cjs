const fs=require('fs');const p='scripts/verify-stock-original.ts';let s=fs.readFileSync(p,'utf8');const c=s.includes('\r\n');if(c)s=s.split('\r\n').join('\n');
const rep=(a,b)=>{if(s.split(a).length!==2){console.log('MISS',a.slice(0,70));process.exit(1)}s=s.replace(a,b)};
rep("  let vOne = await resolveVariantId(T, FIX.id, 'One');\n  if (!vOne) {\n    const w = await writeProductToPostgres(T, {\n      id: FIX.id, name: 'Stock proof fixture (hidden)', slug: FIX.slug, tagline: '', desc: '',\n      isActive: false,",
    "  // Draft products are not for sale (isHiddenFromSale), so the fixture is LIVE\n  // only while this proof runs, and set back to draft in `finally`.\n  const fixture = (isActive: boolean) => writeProductToPostgres(T, {\n      id: FIX.id, name: 'Stock proof fixture', slug: FIX.slug, tagline: '', desc: '',\n      isActive,");
rep("      notes: [], images: [], categories: [],\n    } as any);\n    if (!w.ok) throw new Error('fixture: ' + w.error);\n    vOne = await resolveVariantId(T, FIX.id, 'One');\n  }\n  const v1 = String(vOne);",
    "      notes: [], images: [], categories: [],\n    } as any);\n  const w = await fixture(true);\n  if (!w.ok) throw new Error('fixture: ' + w.error);\n  const v1 = String(await resolveVariantId(T, FIX.id, 'One'));");
rep("    await stock.setStock(T, v2, 0, 'verify-stock-original', run + ' cleanup').catch(() => null);\n    console.log('\nfixture back to 0, holds released');",
    "    await stock.setStock(T, v2, 0, 'verify-stock-original', run + ' cleanup').catch(() => null);\n    await fixture(false).catch(() => null);\n    console.log('\nfixture back to 0 and draft (hidden), holds released');");
fs.writeFileSync(p,c?s.split('\n').join('\r\n'):s);console.log('ok');
