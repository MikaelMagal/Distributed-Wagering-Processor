import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('serializa sempre com escala 2', () => {
    expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('25.5').toJSON().amount).toBe('25.50');
    expect(brl('0.10').toString()).toBe('0.10 BRL');
  });

  test('não sofre erro de ponto flutuante (0.10 + 0.20 == 0.30)', () => {
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
  });

  test('é imutável: operações retornam novas instâncias', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toJSON().amount).toBe('10.00');
    expect(b.toJSON().amount).toBe('15.00');
  });

  test('subtract pode ficar negativo; negate inverte o sinal', () => {
    const r = brl('10.00').subtract(brl('30.00'));
    expect(r.isNegative()).toBe(true);
    expect(r.toJSON().amount).toBe('-20.00');
    expect(r.negate().toJSON().amount).toBe('20.00');
  });

  test('zero / predicados', () => {
    const z = Money.zero('BRL');
    expect(z.isZero()).toBe(true);
    expect(z.isPositive()).toBe(false);
    expect(z.isNegative()).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
  });

  test('comparações', () => {
    expect(brl('10.00').isLessThan(brl('10.01'))).toBe(true);
    expect(brl('10.00').isLessThan(brl('10.00'))).toBe(false);
    expect(brl('10').equals(brl('10.00'))).toBe(true);
  });

  test.each([
    ['NaN'],
    ['Infinity'],
    ['1e3'],
    ['1E3'],
    [''],
    [' '],
    ['1.234'],
    ['-5.00'],
    ['+5.00'],
    ['1,50'],
    ['.5'],
    ['5.'],
    ['abc'],
  ])('rejeita amount inválido: %p', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('rejeita amount que não é string (number nunca é aceito)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  test.each([[''], ['br'], ['brl'], ['BRLL'], ['B1L']])('rejeita currency inválida: %p', (c) => {
    expect(() => Money.from({ amount: '1.00', currency: c })).toThrow(InvalidMoneyError);
  });

  test('conflito de moeda lança erro de domínio em todas as operações binárias', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  test('valores grandes mantêm precisão exata', () => {
    const big = brl('9999999999999999.99');
    expect(big.add(brl('0.01')).toJSON().amount).toBe('10000000000000000.00');
  });
});
