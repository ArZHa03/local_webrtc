
import selfsigned from 'selfsigned';
import { writeFileSync } from 'fs';
import { join } from 'path';

const attrs = [{ name: 'commonName', value: 'localhost' }];
const pems = selfsigned.generate(attrs, { days: 365 });

writeFileSync(join(import.meta.dir, 'certs', 'server.key'), pems.private);
writeFileSync(join(import.meta.dir, 'certs', 'server.crt'), pems.cert);
console.log('Certificates generated successfully in certs/');
