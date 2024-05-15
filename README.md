# @vuemap/amap-xyz-layer
[![npm (tag)](https://img.shields.io/npm/v/@vuemap/amap-xyz-layer)](https://www.npmjs.org/package/@vuemap/amap-xyz-layer)
[![NPM downloads](http://img.shields.io/npm/dm/@vuemap/amap-xyz-layer.svg)](https://npmjs.org/package/@vuemap/amap-xyz-layer)
![JS gzip size](https://img.shields.io/bundlephobia/minzip/%40vuemap/amap-xyz-layer/latest)
[![NPM](https://img.shields.io/npm/l/@vuemap/amap-xyz-layer)](https://github.com/yangyanggu/amap-xyz-layer)
[![star](https://badgen.net/github/stars/yangyanggu/amap-xyz-layer)](https://github.com/yangyanggu/amap-xyz-layer)

### 示例
[codepen示例](https://codepen.io/yangyanggu/pen/vYQQwBO)

### 简介
本项目为高德地图的自定义加载瓦片插件，支持瓦片纠偏，可以加载`WGS84`、`gcj02`、`bd09`三种坐标系瓦片。项目基于：https://github.com/gisarmory/mapboxgl.InternetMapCorrection/tree/main/src 进行改造。


### 加载方式
当前项目支持CDN加载和npm加载两种方式。

#### CDN加载
CDN加载需要先加载高德地图JS，代码如下
```js
<!--加载高德地图JS 2.0 -->
<script src = 'https://webapi.amap.com/maps?v=2.0&key=YOUR_KEY'></script>
<!--加载自定义瓦片插件 -->
<script src="https://cdn.jsdelivr.net/npm/@vuemap/amap-xyz-layer/dist/index.js"></script>
```

#### npm加载
npm加载可以直接使用安装库
```shell
npm install @vuemap/amap-xyz-layer
```

### 使用示例

#### CDN方式
```js
<script src = 'https://webapi.amap.com/maps?v=2.0&key=YOUR_KEY'></script>
<script src="https://cdn.jsdelivr.net/npm/@vuemap/amap-xyz-layer/dist/index.js"></script>
<script type="text/javascript">
  const center = [116.335036, 39.900082];
  const map = new AMap.Map(app', {
      center: center,
      zoom: 10,
      viewMode: '3D',
      pitch: 35,
    });
    const gaodeLayer = new AMap.CustomXyzLayer(map, {
        url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
        subdomains: ["1", "2", "3", "4"]
    })

    const tiandituLayer = new AMap.CustomXyzLayer(map, {
        url: 'http://t{s}.tianditu.com/DataServer?T=img_w&X={x}&Y={y}&L={z}&tk=xxxx',
        subdomains: ["1", "2", "3", "4"],
        proj: 'wgs84'
    })

    const baiduLayer = new AMap.CustomXyzLayer(map, {
        url: 'https://maponline{s}.bdimg.com/starpic/?qt=satepc&u=x={x};y={y};z={z};v=009;type=sate&fm=46',
        subdomains: ["1", "2", "3"],
        proj: 'bd09',
        tileType: 'bd09'
    })
</script>
```

#### npm方式
```js
import {CustomXyzLayer} from '@vuemap/amap-xyz-layer'
const map = new AMap.Map('app', {
  center: [120,31],
  zoom: 14,
  viewMode: '3D',
  pitch: 35,
})
const gaodeLayer = new CustomXyzLayer(map, {
    url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    subdomains: ["1", "2", "3", "4"]
})

const tiandituLayer = new CustomXyzLayer(map, {
    url: 'http://t{s}.tianditu.com/DataServer?T=img_w&X={x}&Y={y}&L={z}&tk=xxxx',
    subdomains: ["1", "2", "3", "4"],
    proj: 'wgs84'
})

const baiduLayer = new CustomXyzLayer(map, {
    url: 'https://maponline{s}.bdimg.com/starpic/?qt=satepc&u=x={x};y={y};z={z};v=009;type=sate&fm=46',
    subdomains: ["1", "2", "3"],
    proj: 'bd09',
    tileType: 'bd09'
})
```

### API文档说明

#### CustomXyzLayer说明
自定义瓦片图层<br/>
``  new AMap.CustomXyzLayer(map: AMap.Map, options)  ``<br/>
###### 参数说明
map: 地图实例对象<br/>
options: 自定义瓦片图层的参数 <br/>

###### options参数说明
| 属性名         | 属性类型                                           | 属性描述                                                                                               |
|-------------|------------------------------------------------|----------------------------------------------------------------------------------------------------|
| url         | string                                         | 瓦片地址，支持 {s} {x} {y} {z}，示例：`http://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}` |
| subdomains  | string[]                                       | 子域名数组，当url中设置{s}后，该属性必填                                                                            | 
| tileType    | 'xyz' \| 'bd09'                                | 瓦片分割类型，默认是`xyz`，xyz代表瓦片是编号是从左上角开始，百度瓦片是由中间开始，所以需要区分普通瓦片还是百度                                        |
| proj        | 'wgs84' \| 'gcj02' \| 'bd09'                   | 瓦片使用的坐标系，默认是`gcj02`                                                                                |
| zooms       | [number,number]                                | 图层缩放等级范围，默认 [2, 18]                                                                                |
| opacity     | number                                         | 图层透明度，默认为 1                                                                                        |
| visible     | boolean                                        | 图层是否可见，默认为 true                                                                                    |
| zIndex      | number                                         | 图层的层级，默认为 120                                                                                      | 
 | debug       | boolean                                        | 开启debug后瓦片上将显示瓦片编号                                                                                 |
| mask        | number[][] \| number[][][]   \| number[][][][] | 瓦片掩膜，数据结构与AMap.Map的mask参数一致                                                                        |
| cacheSize   | number                                         | 瓦片缓存数量，默认-1，不限制缓存瓦片数                                                                               |
| tileMaxZoom | number                                         | 瓦片在服务器的最大层级，当地图zoom超过该层级后直接使用该层级作为做大层级瓦片，默认18                                                      |
| altitude    | number                                         | 加载的瓦片海拔，设置该值后，在3D模式下瓦片将浮空，默认：0                                                                     |

###### 成员函数

| 函数名        | 入参                                                          | 返回值                                                         | 描述                           |
|------------|-------------------------------------------------------------|-------------------------------------------------------------|------------------------------|
| show       | 无                                                           | 无                                                           | 显示图层                         |
| hide       | 无                                                           | 无                                                           | 隐藏图层                         |
| getzIndex  | 无                                                           | number                                                      | 获取图层层级                       |
 | setzIndex  | number                                                      | 无                                                           | 设置图层层级                       |
| getOpacity | 无                                                           | number                                                      | 获取图层透明度                      | 
| setOpacity | number                                                      | 无                                                           | 设置图层透明度                      |
| getZooms   | 无                                                           | [number, number]                                            | 获取图层的显示层级                    |
| setZooms   | [number, number]                                            | 无                                                           | 设置图层显示层级                     |
| destroy    | 无                                                           | 无                                                           | 销毁图层，自动从地图上移除图层              |
| setMask    | undefined \| number[][] \| number[][][]   \| number[][][][] | 无                                                           | 设置掩膜，可以通过传undefined删除之前设置的掩膜 |
| getMask    | 无                                                           | undefined \| number[][] \| number[][][]   \| number[][][][] | 获取掩膜数据                       |
###### 事件列表
暂无事件

| 事件名 | 参数 | 描述 |
| ---- | ---- | ---- |

