// api.js 纯函数测试：地址 → 城市/关键词解析。
// 针对「南京搜不到门店」修复：旧 guessCity 只认带「市」的写法、不剥省份前缀。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessCity, parseCity } from '../web/js/api.js';

test('parseCity：省名+城市+地标 → 城市带市、关键词是地标', () => {
  assert.deepEqual(parseCity('江苏南京徐庄软件园'), { city: '南京市', keyword: '徐庄软件园' });
});

test('parseCity：带「省」「市」后缀的完整写法 → 剥省份、城市带市', () => {
  assert.deepEqual(parseCity('江苏省南京市建邺区河西大街'), { city: '南京市', keyword: '建邺区河西大街' });
});

test('parseCity：只写到城市（无地标） → 关键词回退为城市名本身', () => {
  assert.deepEqual(parseCity('江苏南京'), { city: '南京市', keyword: '南京' });
  assert.deepEqual(parseCity('南京市'), { city: '南京市', keyword: '南京' });
});

test('parseCity：旧写法「上海市黄浦区…」仍解析正确', () => {
  assert.deepEqual(parseCity('上海市黄浦区人民广场'), { city: '上海市', keyword: '黄浦区人民广场' });
});

test('parseCity：直辖市无「市」写法也能解析', () => {
  assert.deepEqual(parseCity('上海黄浦区'), { city: '上海市', keyword: '黄浦区' });
  assert.deepEqual(parseCity('北京徐汇'), { city: '北京市', keyword: '徐汇' });
});

test('parseCity：长城市名优先（南京不被「南」截断）', () => {
  assert.equal(parseCity('南通万达广场').city, '南通市');
  assert.equal(parseCity('南京新街口').city, '南京市');
});

test('parseCity：兜底识别自治州等后缀', () => {
  assert.deepEqual(parseCity('延边朝鲜族自治州延吉'), { city: '延边朝鲜族自治州', keyword: '延吉' });
});

test('parseCity：解析不出城市时返回空城市、原文当关键词', () => {
  assert.deepEqual(parseCity('火星基地一号'), { city: '', keyword: '火星基地一号' });
  assert.deepEqual(parseCity(''), { city: '', keyword: '' });
  assert.deepEqual(parseCity(null), { city: '', keyword: '' });
});

test('guessCity：是 parseCity().city 的薄封装', () => {
  assert.equal(guessCity('江苏南京徐庄软件园'), '南京市');
  assert.equal(guessCity('江苏省南京市建邺区'), '南京市');
  assert.equal(guessCity('江苏南京'), '南京市');
  assert.equal(guessCity('上海市黄浦区'), '上海市');
  assert.equal(guessCity('火星基地'), '');
});
