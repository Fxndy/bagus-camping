const payment = require('./payment-config.json');
const maxRentalDays = Number(process.env.MAX_RENTAL_DAYS || 30);
if (!Number.isSafeInteger(maxRentalDays) || maxRentalDays < 1 || maxRentalDays > 3650) throw new Error('MAX_RENTAL_DAYS harus bilangan bulat antara 1 dan 3650.');
const clean = value => typeof value === 'string' ? value.trim() : '';
const bank = Object.fromEntries(['bankName', 'accountNumber', 'accountHolder'].map(key => [key, clean(payment.seabank?.[key])]));
const gopay = Object.fromEntries(['phoneNumber', 'accountHolder'].map(key => [key, clean(payment.gopay?.[key])]));
const paymentMethods = [
  { value: 'SeaBank', label: 'SeaBank', ...bank, configured: Boolean(bank.bankName && bank.accountNumber) },
  { value: 'GoPay', label: 'GoPay', ...gopay, configured: Boolean(gopay.phoneNumber) }
];
module.exports = { maxRentalDays, paymentMethods, whatsappNumber: '6285777598395', maxUploadBytes: 4 * 1024 * 1024 };
