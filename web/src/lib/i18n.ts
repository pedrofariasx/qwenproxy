import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import ptBR from '@/locales/pt-BR.json'
import en from '@/locales/en.json'
import zhCN from '@/locales/zh-CN.json'

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'pt-BR': { translation: ptBR },
      en: { translation: en },
      'zh-CN': { translation: zhCN },
    },
    fallbackLng: 'en',
    supportedLngs: ['en', 'pt-BR', 'zh-CN'],
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
  })

export default i18n
