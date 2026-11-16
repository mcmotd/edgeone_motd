import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fetch: pingJava } = require('../backend/utils/java');
const pingBedrock = require('../backend/utils/bedrock');
const varint = require('varint');

function statusPacket(json) {
  const text = Buffer.from(json);
  const body = Buffer.concat([Buffer.from([0]), Buffer.from(varint.encode(text.length)), text]);
  return Buffer.concat([Buffer.from(varint.encode(body.length)), body]);
}

async function javaServer(t, json, fragment = false) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => {
      const packet = statusPacket(json);
      if (fragment) {
        socket.write(packet.subarray(0, 1));
        setImmediate(() => socket.end(packet.subarray(1)));
      } else socket.end(packet);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

test('Java accepts fragmented status packets including a multibyte frame length', async t => {
  const status = { description: '§a欢迎'.repeat(80), version: { name: '1.21', protocol: 767 }, players: { online: 3, max: 20 } };
  const port = await javaServer(t, JSON.stringify(status), true);
  assert.deepEqual(await pingJava('127.0.0.1', port, 1000), status);
});

test('Java rejects a complete malformed JSON response rather than leaving its promise pending', async t => {
  const port = await javaServer(t, '{invalid');
  await assert.rejects(pingJava('127.0.0.1', port, 1000), SyntaxError);
});

async function bedrockServer(t, advertisement) {
  const server = dgram.createSocket('udp4');
  const magic = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
  let received;
  server.on('message', (ping, peer) => {
    received = ping;
    const text = Buffer.from(advertisement);
    const reply = Buffer.alloc(35 + text.length);
    reply[0] = 0x1c;
    ping.copy(reply, 1, 1, 9);
    reply.writeBigInt64BE(123n, 9);
    magic.copy(reply, 17);
    reply.writeUInt16BE(text.length, 33);
    text.copy(reply, 35);
    server.send(reply, peer.port, peer.address);
  });
  await new Promise(resolve => server.bind(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, get received() { return received; } };
}

function queryBedrock(port) {
  return new Promise((resolve, reject) => pingBedrock('127.0.0.1', port,
    (error, data) => error ? reject(error) : resolve(data), 1000));
}

test('Bedrock sends standard RakNet ping and decodes both UTF-8 MOTD lines and metadata', async t => {
  const server = await bedrockServer(t, 'MCPE;§a基岩测试;800;1.21;2;10;123;世界;Survival;1;19132;19133;');
  const data = await queryBedrock(server.port);
  assert.equal(server.received.length, 33);
  assert.equal(server.received[0], 1);
  assert.deepEqual(server.received.subarray(9, 25), Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex'));
  assert.equal(data.name, '§a基岩测试\n世界');
  assert.equal(data.cleanName, '基岩测试\n世界');
  assert.deepEqual(data.motdLines, ['§a基岩测试', '世界']);
  assert.equal(data.edition, 'MCPE');
  assert.equal(data.protocol, '800');
  assert.equal(data.version, '1.21');
  assert.equal(data.currentPlayers, '2');
  assert.equal(data.maxPlayers, '10');
  assert.equal(data.serverID, '123');
  assert.equal(data.levelname, '世界');
  assert.equal(data.gamemode, 'Survival');
  assert.equal(data.gamemodeId, '1');
  assert.equal(data.ipv4Port, '19132');
  assert.equal(data.ipv6Port, '19133');
});

test('Bedrock preserves the second MOTD when the first is empty and strips its extended color codes', async t => {
  const server = await bedrockServer(t, 'MCPE;;800;1.21.124;0;50;13253860892328930865;§m§l第二行§g金币§w蓝色;Survival;1;19132;19133;');
  const data = await queryBedrock(server.port);
  assert.equal(data.name, '§m§l第二行§g金币§w蓝色');
  assert.equal(data.cleanName, '第二行金币蓝色');
  assert.deepEqual(data.motdLines, ['', '§m§l第二行§g金币§w蓝色']);
  assert.equal(data.serverID, '13253860892328930865');
  assert.equal(data.levelname, '第二行金币蓝色');
});

test('Bedrock accepts legacy and Education advertisements without optional fields', async t => {
  for (const edition of ['MCPE', 'MCEE']) {
    await t.test(edition, async t => {
      const server = await bedrockServer(t, `${edition};§a旧版;100;1.0;0;10`);
      const data = await queryBedrock(server.port);
      assert.equal(data.edition, edition);
      assert.equal(data.name, '§a旧版');
      assert.deepEqual(data.motdLines, ['§a旧版', '']);
      for (const field of ['serverID', 'levelname', 'gamemode', 'gamemodeId', 'ipv4Port', 'ipv6Port']) {
        assert.equal(data[field], null, field);
      }
    });
  }
});

test('Bedrock rejects advertisements from non-Minecraft RakNet services', async t => {
  const server = await bedrockServer(t, 'OTHER;Not Minecraft;800;1.21;0;10');
  await assert.rejects(queryBedrock(server.port), /Invalid Bedrock advertisement/);
});

test('Bedrock status HTTP API returns both MOTD lines and complete server-list metadata', async t => {
  const previousStorageEnabled = process.env.STORAGE_ENABLED;
  process.env.STORAGE_ENABLED = 'false';
  t.after(() => {
    if (previousStorageEnabled === undefined) delete process.env.STORAGE_ENABLED;
    else process.env.STORAGE_ENABLED = previousStorageEnabled;
  });
  const server = await bedrockServer(t, 'MCPE;§l§m红色服;800;1.21.124;0;50;13253860892328930865;§n铜色行;Survival;1;19132;19133;');
  const express = require('express');
  const app = express();
  app.use('/api', require('../backend/app'));
  const http = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise(resolve => http.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${http.address().port}/api/status?host=127.0.0.1:${server.port}&stype=be`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.status, 'online');
  assert.equal(data.type, 'Bedrock');
  assert.equal(data.motd, '§l§m红色服\n§n铜色行');
  assert.equal(data.pureMotd, '红色服\n铜色行');
  assert.deepEqual(data.motdLines, ['§l§m红色服', '§n铜色行']);
  assert.equal(data.edition, 'MCPE');
  assert.equal(data.serverID, '13253860892328930865');
  assert.equal(data.levelname, '铜色行');
  assert.equal(data.gamemodeId, '1');
  assert.equal(data.ipv4Port, '19132');
  assert.equal(data.ipv6Port, '19133');
});
