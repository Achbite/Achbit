import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
let server;
input.once('line', line => {
  const initialization = JSON.parse(line);
  if (initialization.protocol !== 'achbit.service-plugin.v1') throw new Error('Unsupported initialization protocol');
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Plugin service is running.' }));
  });
  server.listen(0, '127.0.0.1', () => {
    console.log(JSON.stringify({ protocol: initialization.protocol, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
});
input.on('close', () => { if (server) server.close(); });
