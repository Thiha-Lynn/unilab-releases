const fs=require('node:fs'),path=require('node:path');
const lock=require('../app/package-lock.json');
const rows=[];
fs.mkdirSync('web/licenses',{recursive:true});
for(const [location,item] of Object.entries(lock.packages)) {
 if(!location||item.dev)continue;
 const dir=path.resolve('app',location);
 if(!fs.existsSync(dir))throw Error('Missing production dependency '+location);
 const pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json')));
 const target=path.join('web/licenses',pkg.name.replaceAll('/','__'));
 fs.mkdirSync(target,{recursive:true});
 const files=fs.readdirSync(dir).filter(n=>/^(license|copying|notice|thirdpartylicenses)/i.test(n)&&fs.statSync(path.join(dir,n)).isFile());
 for(const file of files)fs.copyFileSync(path.join(dir,file),path.join(target,file));
 rows.push({name:pkg.name,version:pkg.version,license:pkg.license,repository:pkg.repository,notices:files});
}
fs.writeFileSync('web/licenses/dependencies.json',JSON.stringify(rows,null,2)+'\n');
fs.copyFileSync('THIRD_PARTY.md','web/licenses/README.md');
