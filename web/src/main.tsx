import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';

import App from './App';
import './theme.css';
import './app.css';

// AntD 主题适配：token 与 theme.css 的语义色板对齐，
// 让 AntD 控件的默认外观与本应用的视觉语言一致。
const antdTheme = {
  cssVar: true,
  token: {
    colorPrimary: '#155AEF',
    colorBgLayout: '#F2F4F7',
    colorBgContainer: '#FFFFFF',
    colorText: '#1E252E',
    colorTextSecondary: '#475468',
    colorBorder: '#EAECF0',
    colorSuccess: '#27C274',
    colorWarning: '#FAAD14',
    colorInfo: '#1677FF',
    colorError: '#F43B2C',
  },
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider theme={antdTheme} locale={zhCN}>
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>
);
