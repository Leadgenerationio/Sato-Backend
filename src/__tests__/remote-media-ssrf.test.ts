import { describe, it, expect } from 'vitest';
import { isPrivateAddress } from '../utils/remote-media.js';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '192.0.0.8', '198.18.0.1', '::1', '::', 'fe80::1', 'FE80::1', 'fc00::1', 'fd12::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', 'ff02::1', 'garbage',
  ])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808'])(
    'allows %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});
