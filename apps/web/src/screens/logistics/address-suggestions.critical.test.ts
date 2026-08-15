/**
 * Проверки выпадающего списка подсказок адреса.
 *
 * Свойство одно и общее для формы склада и правки адреса заказа: после выбора
 * список закрывается и нового запроса не уходит, а открывается он снова только
 * после того, как текст изменил человек.
 */

import { describe, expect, it } from 'vitest';
import {
  acceptSuggestion,
  EMPTY_SUGGEST_BOX,
  isSuggestListOpen,
  MIN_SUGGEST_QUERY,
  shouldRequestSuggestions,
  suggestBoxFrom,
  typeInSuggestBox,
} from './address-suggestions';

const ADDRESS = 'Москва, Цветочная улица, 1';

describe('подбор подсказок', () => {
  it('короткий и пустой запрос подсказок не просит', () => {
    expect(shouldRequestSuggestions(EMPTY_SUGGEST_BOX)).toBe(false);
    expect(
      shouldRequestSuggestions({ text: 'а'.repeat(MIN_SUGGEST_QUERY - 1), acceptedFor: null }),
    ).toBe(false);
  });

  it('набранный текст подсказки просит и открывает список', () => {
    const box = typeInSuggestBox(EMPTY_SUGGEST_BOX, 'Москва, Цвет');

    expect(shouldRequestSuggestions(box)).toBe(true);
    expect(isSuggestListOpen(box, true)).toBe(true);
  });

  it('после выбора список закрыт и новый запрос не уходит', () => {
    // Прежде выбранное значение попадало обратно в ключ запроса, и список
    // тут же открывался снова на только что принятый адрес.
    const box = acceptSuggestion(ADDRESS);

    expect(box.text).toBe(ADDRESS);
    expect(shouldRequestSuggestions(box)).toBe(false);
    expect(isSuggestListOpen(box, true)).toBe(false);
  });

  it('правка текста после выбора снова открывает подбор', () => {
    const edited = typeInSuggestBox(acceptSuggestion(ADDRESS), `${ADDRESS}, подъезд 2`);

    expect(shouldRequestSuggestions(edited)).toBe(true);
    expect(isSuggestListOpen(edited, true)).toBe(true);
  });

  it('возврат к ровно тому же тексту выбор не отменяет', () => {
    // Курсор поставили и убрали, ничего не изменив: открывать список незачем.
    const same = typeInSuggestBox(acceptSuggestion(ADDRESS), ADDRESS);

    expect(shouldRequestSuggestions(same)).toBe(false);
  });

  it('пустой ответ список не открывает', () => {
    expect(isSuggestListOpen(typeInSuggestBox(EMPTY_SUGGEST_BOX, 'Москва, Цвет'), false)).toBe(
      false,
    );
  });

  it('готовый адрес заказа открывается без выбора и подсказки просит', () => {
    expect(shouldRequestSuggestions(suggestBoxFrom(ADDRESS))).toBe(true);
  });
});
