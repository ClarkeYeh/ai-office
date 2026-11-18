import { createHash, randomBytes } from 'node:crypto';
import { AIO_NAMESPACE, type Clock, type IdGen } from '../../ports/services.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Monotonic within one generator, including when the wall clock moves backwards. */
export class SystemIdGen implements IdGen {
  private timestamp = -1;
  private random = 0n;
  constructor(private readonly clock: Clock = new SystemClock()) {}
  ulid(): string {
    const now = this.clock.now().getTime();
    if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff)
      throw new RangeError('Invalid ULID timestamp');
    if (now > this.timestamp) {
      this.timestamp = now;
      this.random = BigInt('0x' + randomBytes(10).toString('hex'));
    } else {
      if (this.random === (1n << 80n) - 1n)
        throw new RangeError('ULID entropy exhausted');
      this.random++;
    }
    let value = (BigInt(this.timestamp) << 80n) | this.random;
    let result = '';
    for (let i = 0; i < 26; i++) {
      result = alphabet[Number(value & 31n)] + result;
      value >>= 5n;
    }
    return result;
  }
  shortId(): string {
    return randomBytes(6).toString('hex');
  }
  orcaRequestId(commandId: string): string {
    const bytes = createHash('sha1')
      .update(Buffer.from(AIO_NAMESPACE.replaceAll('-', ''), 'hex'))
      .update(commandId, 'utf8')
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6]! & 15) | 80;
    bytes[8] = (bytes[8]! & 63) | 128;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}
