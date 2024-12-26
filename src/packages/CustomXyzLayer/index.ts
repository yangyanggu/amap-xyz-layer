import earcut from 'earcut';
import {Matrix4} from "@math.gl/core";
import {
    lonLatToTileNumbers, tileNumbersToLonLat,
    gcj02_To_gps84, gps84_To_gcj02,
    gcj02_To_bd09, bd09_To_gcj02
} from '../support/coordConver'
import TransformClassBaidu from '../support/transform-class-baidu'
import {template} from '../support/Util.js'
import type { ResultLngLat } from '../support/coordConver'

// 掩膜数据结构
type MaskType = number[][] | number[][][] | number[][][][]

export interface XyzLayerOptions{
    url: string
    subdomains?: string[]
    tileType?: 'xyz' | 'bd09'
    proj?: 'wgs84' | 'gcj02' | 'bd09'
    zooms?: [number, number]
    opacity?: number
    visible?: boolean
    zIndex?: number
    debug?: boolean
    mask?: MaskType
    cacheSize?: number
    tileMaxZoom?: number // 瓦片在服务器的最大层级，当地图zoom超过该层级后直接使用该层级作为做大层级瓦片
    altitude?: number // 瓦片海拔
}

interface XYZ {
    x: number
    y: number
    z: number
}

interface PosParamType {
    size: number
    stride: number
    offset: number
}

interface TileType {
    xyz: XYZ
    xyzKey: string
    buffer?: WebGLBuffer
    PosParam?: PosParamType
    TextCoordParam?: PosParamType
    texture?: WebGLTexture
    isLoad: boolean
    url: string
    image?: HTMLImageElement
    imageCanceled: boolean
    imageError?: boolean
}

// mask缓存数据
interface MaskCacheType {
    FSIZE: number
    vertexBuffer: WebGLBuffer
    indexBuffer: WebGLBuffer
    deviationLength: number
}

class CustomXyzLayer {
    options: XyzLayerOptions
    map: any // 地图对象
    gl: any
    layer: any
    customCoords: any
    center: any

    //着色器程序
    program = null as any;
    //存放当前显示的瓦片
    showTiles: TileType[] = [];

    isReadRender = false;

    //记录当前图层是否在显示
    isLayerShow = false;

    //存放所有加载过的瓦片
    tileCache: TileType[] = [];

    //存放瓦片号对应的经纬度
    gridCache: Record<string, ResultLngLat> = {}

    transformBaidu = new TransformClassBaidu()

    a_Pos: GLint | undefined;
    a_TextCoord: GLint | undefined

    mapCallback: any

    maskCache: MaskCacheType[] = []

    // 掩膜的着色器程序
    maskProgram: any

    mask_Pos: GLint | undefined;

    // 以下两个为透视投影使用矩阵
    // 投影矩阵
    _projectionMatrix = new Matrix4()
    // 视图矩阵
    _viewMatrix4 = new Matrix4();

    // 正交投影使用
    _mvpMatrix4 = new Matrix4();

    // 是否是2D的正交投影
    isOrtho = false;

    constructor(map: any, options: XyzLayerOptions) {
        if (!map) {
            throw new Error('请传入地图实例')
        }
        this.validate(options);
        this.map = map
        this.center = map.getCenter().toArray();
        this.options = Object.assign(this.getDefaultGlLayerOptions(), options);
        this.customCoords = map.customCoords;
        // 数据使用转换工具进行转换，这个操作必须要提前执行（在获取镜头参数 函数之前执行），否则将会获得一个错误信息。
        this.customCoords.lngLatsToCoords([
            this.center
        ]);

        this.layer = new AMap.GLCustomLayer({
            // 图层的层级
            zooms: this.options.zooms,
            opacity: this.options.opacity,
            visible: this.options.visible,
            zIndex: this.options.zIndex,
            // 初始化的操作，创建图层过程中执行一次。
            init: (gl) => {
                this.gl = gl;
                const vertexSource = `
                    uniform mat4 u_ProjectionMatrix;
                    uniform mat4 u_ViewMatrix4;
                    uniform mat4 u_MvpMatrix4;
                    uniform bool u_isOrtho;
                    attribute vec2 a_pos;
                    attribute vec2 a_TextCoord;
                    varying vec2 v_TextCoord;
                    void main() {
                       if(u_isOrtho){
                         gl_Position = u_MvpMatrix4 * vec4(a_pos,0.0, 1.0);
                       }else{
                         gl_Position = u_ProjectionMatrix * u_ViewMatrix4 * vec4(a_pos,0.0, 1.0);
                       }
                       v_TextCoord = a_TextCoord;
                    }`;

                const fragmentSource = `
                    precision mediump float;
                    uniform sampler2D u_Sampler;
                    uniform bool u_isFirst;
                    varying vec2 v_TextCoord;
                    void main() {
                       if(u_isFirst){
                         gl_FragColor = vec4(1.0, 0.0, 0.0, 0.0);
                       }else{
                         gl_FragColor = texture2D(u_Sampler, v_TextCoord);
                       }
                    }`;

                //初始化顶点着色器
                const vertexShader = gl.createShader(gl.VERTEX_SHADER);
                gl.shaderSource(vertexShader, vertexSource);
                gl.compileShader(vertexShader);
                //初始化片元着色器
                const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
                gl.shaderSource(fragmentShader, fragmentSource);
                gl.compileShader(fragmentShader);
                //初始化着色器程序
                this.program = gl.createProgram();
                gl.attachShader(this.program, vertexShader);
                gl.attachShader(this.program, fragmentShader);
                gl.linkProgram(this.program);

                //获取顶点位置变量
                this.a_Pos = gl.getAttribLocation(this.program, "a_pos");
                this.a_TextCoord = gl.getAttribLocation(this.program, 'a_TextCoord');

                //掩膜处理

                const maskVertexSource = "" +
                    "uniform mat4 u_ProjectionMatrix;" +
                    "uniform mat4 u_ViewMatrix4;" +
                    "uniform mat4 u_MvpMatrix4;" +
                    "uniform bool u_isOrtho;"+
                    "attribute vec2 a_pos;" +
                    "void main() {" +
                    "   if(u_isOrtho){"+
                    "     gl_Position = u_MvpMatrix4 * vec4(a_pos,0.0, 1.0);" +
                    "   }else{"+
                    "     gl_Position = u_ProjectionMatrix * u_ViewMatrix4 * vec4(a_pos,0.0, 1.0);" +
                    "   }"+
                    "}";

                const maskFragmentSource = "" +
                    "void main() {" +
                    "    gl_FragColor = vec4(0.0, 1.0, 0.0, 0.0);" +
                    "}";

                //初始化掩膜顶点着色器
                const maskVertexShader = gl.createShader(gl.VERTEX_SHADER);
                gl.shaderSource(maskVertexShader, maskVertexSource);
                gl.compileShader(maskVertexShader);
                //初始化掩膜片元着色器
                const maskFragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
                gl.shaderSource(maskFragmentShader, maskFragmentSource);
                gl.compileShader(maskFragmentShader);
                //初始化着色器程序
                this.maskProgram = gl.createProgram();
                gl.attachShader(this.maskProgram, maskVertexShader);
                gl.attachShader(this.maskProgram, maskFragmentShader);
                gl.linkProgram(this.maskProgram);

                //获取顶点位置变量
                this.mask_Pos = gl.getAttribLocation(this.maskProgram, "a_pos");

                if(this.options.visible){
                    this.isLayerShow = true;
                }
                this.mapCallback = () => {
                    if (this.isLayerShow) {
                        this.update()
                    }
                }
                map.on('dragging', this.mapCallback)
                map.on('moveend', this.mapCallback)
                map.on('zoomchange', this.mapCallback)
                map.on('rotatechange', this.mapCallback)
                this._createMask(this.options.mask);
                this.update()
            },
            render: (gl) => {
                if(!this.isReadRender){
                    return;
                }
                const zooms = this.options.zooms as [number, number];
                if (this.map.getZoom() < zooms[0] || this.map.getZoom() > zooms[1]) {
                    return
                }
                this.customCoords.setCenter(this.center);
                if (map.getView().type === '3D') {
                    this.isOrtho = false;
                    const {near, far, fov, up, lookAt, position} = this.customCoords.getCameraParams() as {
                        near: number;
                        far: number;
                        fov: number;
                        up: [number, number, number];
                        lookAt: [number, number, number];
                        position: [number, number, number]
                    };
                    this._viewMatrix4.lookAt({
                        eye: position,
                        center: lookAt,
                        up
                    }).translate([0,0,this.options.altitude as number]);
                    this._projectionMatrix.perspective({
                        fovy: fov * Math.PI / 180,
                        far,
                        near,
                        aspect: gl.drawingBufferWidth / gl.drawingBufferHeight
                    })
                }else{
                    this.isOrtho = true;
                    const MVPMatrix = this.customCoords.getMVPMatrix();
                    this._mvpMatrix4.copy(MVPMatrix);
                }

                if(this.maskCache.length > 0){
                    // 清除模板缓存
                    gl.clearStencil(0);
                    gl.clear(gl.STENCIL_BUFFER_BIT);
                    // 开启模板测试
                    gl.enable(gl.STENCIL_TEST);

                    // 设置模板测试参数
                    gl.stencilFunc(gl.ALWAYS, 1, 0xFF);
                    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
                    this._renderMask(gl);

                    // ----- 模板方法 begin -----

                    //设置模板测试参数
                    gl.stencilFunc(gl.EQUAL, 1, 0xFF);
                    //设置模板测试后的操作
                    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

                    // ----- 模板方法 end -----

                    // 关闭深度检测
                    gl.disable(gl.DEPTH_TEST);

                    this._renderTile(gl);
                    // 开启深度检测
                    gl.enable(gl.DEPTH_TEST);

                    // ----- 模板方法 begin -----

                    // 关闭模板测试
                    gl.disable(gl.STENCIL_TEST);
                }else{
                    this._renderTile(gl);
                }
            },
        });
        map.add(this.layer);
    }

    _renderMask(gl){
        if(!this.maskCache.length){
            return;
        }
        this.customCoords.setCenter(this.center);
        //应用着色程序
        //必须写到这里，不能写到onAdd中，不然gl中的着色程序可能不是上面写的，会导致下面的变量获取不到
        gl.useProgram(this.maskProgram);
        // 设置位置的顶点参数
        this.setVertex(gl, this.maskProgram)
        for (const mask of this.maskCache) {
            gl.bindBuffer(gl.ARRAY_BUFFER, mask.vertexBuffer);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mask.indexBuffer);
            //激活顶点数据缓冲区
            gl.vertexAttribPointer(this.mask_Pos as GLint, 2, gl.FLOAT, false,  0, 0);
            gl.enableVertexAttribArray(this.mask_Pos as GLint);
            //绘制图形
            gl.drawElements(gl.TRIANGLES, mask.deviationLength, gl.UNSIGNED_INT, 0);
        }

        // gl.drawElements(gl.TRIANGLES, this.maskCache.deviationLength, gl.UNSIGNED_INT, 0);
    }

    _renderTile(gl) {
        this.customCoords.setCenter(this.center);
        //应用着色程序
        //必须写到这里，不能写到onAdd中，不然gl中的着色程序可能不是上面写的，会导致下面的变量获取不到
        gl.useProgram(this.program);
        // 设置位置的顶点参数
        this.setVertex(gl, this.program)
        let index = 0;
        for (const tile of this.showTiles) {
            if (!tile.isLoad || tile.imageError) continue;

            //向target绑定纹理对象
            gl.bindTexture(gl.TEXTURE_2D, tile.texture as WebGLTexture);
            //开启0号纹理单元
            gl.activeTexture(gl.TEXTURE0);
            //配置纹理参数
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
            // 获取纹理的存储位置
            // eslint-disable-next-line camelcase
            const u_Sampler = gl.getUniformLocation(this.program, 'u_Sampler');
            //将0号纹理传递给着色器
            gl.uniform1i(u_Sampler, 0);

            // 设置是否是第一个瓦片，如果是第一个瓦片就显示为透明
            gl.uniform1f(gl.getUniformLocation(this.program, "u_isFirst"), index === 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, tile.buffer as WebGLBuffer);
            //设置从缓冲区获取顶点数据的规则
            gl.vertexAttribPointer(this.a_Pos, tile.PosParam?.size, gl.FLOAT, false, tile.PosParam?.stride, tile.PosParam?.offset);
            gl.vertexAttribPointer(this.a_TextCoord, tile.TextCoordParam?.size, gl.FLOAT, false, tile.TextCoordParam?.stride, tile.TextCoordParam?.offset);
            //激活顶点数据缓冲区
            gl.enableVertexAttribArray(this.a_Pos);
            gl.enableVertexAttribArray(this.a_TextCoord);


            //开启阿尔法混合，实现注记半透明效果
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

            //绘制图形
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            index++;
        }
    }

    validate(options: XyzLayerOptions) {
        if (!options.url) {
            throw new Error('请传入url');
        }
        if (options.url.includes('{s}') && (!options.subdomains || options.subdomains.length === 0)) {
            throw new Error('请传入subdomains');
        }
    }

    getDefaultGlLayerOptions(): XyzLayerOptions {
        return {
            url: '',
            zooms: [2, 18],
            opacity: 1,
            visible: true,
            zIndex: 120,
            proj: 'gcj02',
            tileType: 'xyz',
            debug: false,
            cacheSize: 512,
            tileMaxZoom: 18,
            altitude: 0
        }
    }

    _createMask(mask?: MaskType) {
        if(!mask || mask.length === 0){
            this.maskCache = [];
            return
        }

        const deep = this.getMaskDeep(mask);
        if(deep < 2 || deep>4){
            // eslint-disable-next-line no-console
            console.warn('mask数据格式不正确')
            return;
        }
        if(deep === 2){
            mask = [[mask]] as any;
        }else if(deep === 3){
            mask = [mask] as any;
        }
        for(let maskItem of mask as number[][][][]){
            maskItem = this._convertMaskLnglatToCoords(maskItem);
            const data = earcut.flatten(maskItem);
            // console.log('earcut: ', earcut)
            const triangles = earcut(data.vertices, data.holes, data.dimensions);
            const gl = this.gl;
            //创建顶点缓冲区对象
            const vertexArray = new Float32Array(data.vertices);
            const vertexBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, vertexArray , gl.STATIC_DRAW);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            // 创建索引缓冲区对象
            const indexBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(triangles), gl.STATIC_DRAW);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
            this.maskCache.push({
                FSIZE: vertexArray.BYTES_PER_ELEMENT,
                vertexBuffer,
                indexBuffer,
                deviationLength: triangles.length
            })
        }

    }

    getMaskDeep(mask: any, deepNumber = 1): number {
        if(!mask.length){
            return -1;
        }
        if(typeof mask[0] === 'number'){
            return deepNumber;
        }
        return this.getMaskDeep(mask[0], deepNumber+1);
    }

    _convertMaskLnglatToCoords(mask: any){
        if(!mask || mask.length === 0){
            return mask;
        }
        if(typeof mask[0] === 'number'){
            return this._convertLnglatToCoords([mask[0], mask[1]]);
        }
        return mask.map(item => this._convertMaskLnglatToCoords(item))
    }

    _convertLnglatToCoords(lnglat: [number, number]) {
        this.customCoords.setCenter(this.center);
        return this.customCoords.lngLatsToCoords([lnglat])[0];
    }


    update() {
        if(!this.gl){
            return;
        }
        this.isReadRender = false;
        const gl = this.gl;
        const map = this.map;
        const center = map.getCenter();
        let zoom = Math.ceil(map.getZoom());
        if(zoom > (this.options.tileMaxZoom as number)){
            zoom = this.options.tileMaxZoom as number;
        }
        const bounds = map.getBounds();
        let minTile: [number, number],
            maxTile: [number, number];
        let northWestLngLat: [number, number];
        let sourceEastLngLat: [number, number];
        if (this.options.tileType === 'xyz') {
            // zoom = parseInt(map.getZoom() + 1.4);   //解决瓦片上文字偏大的问题
            northWestLngLat = bounds.getNorthWest().toArray() as [number, number];
            sourceEastLngLat = bounds.getSouthEast().toArray() as [number, number];
        } else {
            // zoom = parseInt(map.getZoom() + 1.8); //解决瓦片上文字偏大的问题
            northWestLngLat = bounds.getSouthWest().toArray() as [number, number];
            sourceEastLngLat = bounds.getNorthEast().toArray() as [number, number];
        }
        if (this.options.proj === 'wgs84') {
            //把当前显示范围做偏移，后面加载瓦片时会再偏移回来
            //如果不这样做的话，大比例尺时，瓦片偏移后，屏幕边缘会有空白区域
            const northWest = gcj02_To_gps84(...northWestLngLat)
            const southEast = gcj02_To_gps84(...sourceEastLngLat)
            //算出当前范围的瓦片编号
            minTile = lonLatToTileNumbers(northWest.lng, northWest.lat, zoom)
            maxTile = lonLatToTileNumbers(southEast.lng, southEast.lat, zoom)
        } else if (this.options.proj === 'bd09') {
            // zoom = parseInt(map.getZoom() + 1.8); //解决瓦片上文字偏大的问题
            const southWest = gcj02_To_bd09(...northWestLngLat)
            const northEast = gcj02_To_bd09(...sourceEastLngLat)
            minTile = this.transformBaidu.lnglatToTile(southWest.lng, southWest.lat, zoom)
            maxTile = this.transformBaidu.lnglatToTile(northEast.lng, northEast.lat, zoom)
        } else {
            minTile = lonLatToTileNumbers(northWestLngLat[0], northWestLngLat[1], zoom)
            maxTile = lonLatToTileNumbers(sourceEastLngLat[0], sourceEastLngLat[1], zoom)
        }
        const currentTiles: XYZ[] = [];
        for (let x = minTile[0]; x <= maxTile[0]; x++) {
            for (let y = minTile[1]; y <= maxTile[1]; y++) {
                const xyz: XYZ = {
                    x,
                    y,
                    z: zoom
                }
                currentTiles.push(xyz)

                //把瓦片号对应的经纬度缓存起来，
                //存起来是因为贴纹理时需要瓦片4个角的经纬度，这样可以避免重复计算
                //行和列向外多计算一个瓦片数，这样保证瓦片4个角都有经纬度可以取到
                this.addGridCache(xyz, 0, 0)
                if (x === maxTile[0]) {
                    this.addGridCache(xyz, 1, 0)
                }
                if (y === maxTile[1]) {
                    this.addGridCache(xyz, 0, 1)
                }
                if (x === maxTile[0] && y === maxTile[1]) {
                    this.addGridCache(xyz, 1, 1)
                }
            }
        }

        let centerTile: [number, number]
        //瓦片设置为从中间向周边的排序
        if (this.options.tileType === 'xyz') {
            centerTile = lonLatToTileNumbers(center.getLng(), center.getLat(), zoom)
        }  //计算中心点所在的瓦片号
        else{
            centerTile = this.transformBaidu.lnglatToTile(center.getLng(), center.getLat(), zoom)
        }
        currentTiles.sort((a, b) => {
            return this.tileDistance(a, centerTile) - this.tileDistance(b, centerTile);
        });
        this._cancelOutViewImage(currentTiles);
        //加载瓦片
        this._clearShowTile();
        for (const xyz of currentTiles) {
            //走缓存或新加载
            const tileKey = this.createTileKey(xyz);
            const tileCache = this.getTileCache(tileKey)
            if (tileCache) {
                if(tileCache.imageError){
                    continue
                }
                if(!tileCache.isLoad && tileCache.image && tileCache.imageCanceled){
                    tileCache.image.src = tileCache.url;
                    tileCache.imageCanceled = false;
                }
                this.showTiles.push(tileCache);
            } else {
                const tile = this.createTile(gl, xyz)
                this.showTiles.push(tile);
                this.pushTileCache(tile);
            }
        }
        if(this.showTiles.length > 0){
            this.showTiles.unshift(this.showTiles[0]);
        }
        this.isReadRender = true;
    }

    _cancelOutViewImage(currentTiles: XYZ[]){
        this.tileCache.forEach(tile => {
            const index = currentTiles.findIndex(xyz => this.createTileKey(xyz) === tile.xyzKey)
            if(index === -1 && !tile.isLoad){
                if(tile.image){
                    tile.image.src = ''
                    tile.imageCanceled = true;
                }
            }
        })
    }

    getTileCache(key: string){
        return this.tileCache.find(item => item.xyzKey === key)
    }

    pushTileCache(tile: TileType){
        const cacheSize = this.options.cacheSize as number;
        if(cacheSize > 0 && this.tileCache.length >= cacheSize){
            if(this.showTiles.findIndex(item => item.xyzKey === this.tileCache[0].xyzKey) < 0){
                this._destroyTile(this.tileCache[0]);
            }
            this.tileCache.splice(0, 1);
        }
        this.tileCache.push(tile);
    }

    //缓存瓦片号对应的经纬度
    addGridCache(xyz: XYZ, xPlus: number, yPlus: number) {
        const key = this.createTileKey(xyz.x + xPlus, xyz.y + yPlus, xyz.z)
        if (!this.gridCache[key]) {
            if (this.options.proj === 'wgs84') {
                const lnglat = gps84_To_gcj02(...tileNumbersToLonLat(xyz.x + xPlus, xyz.y + yPlus, xyz.z));
                const result = this._convertLnglatToCoords([lnglat.lng, lnglat.lat]);
                this.gridCache[key] = {
                    lng: result[0],
                    lat: result[1]
                }
            } else if (this.options.tileType === 'bd09') {
                const lnglat = bd09_To_gcj02(...this.transformBaidu.pixelToLnglat(0, 0, xyz.x + xPlus, xyz.y + yPlus, xyz.z));
                const result = this._convertLnglatToCoords([lnglat.lng, lnglat.lat]);
                this.gridCache[key] = {
                    lng: result[0],
                    lat: result[1]
                }
            } else {
                const lnglat = this._convertLnglatToCoords(tileNumbersToLonLat(xyz.x + xPlus, xyz.y + yPlus, xyz.z));
                this.gridCache[key] = {
                    lng: lnglat[0],
                    lat: lnglat[1]
                }
            }
        }
    }

    //计算两个瓦片编号的距离
    tileDistance(tile1: XYZ, tile2: [number, number]) {
        //计算直角三角形斜边长度，c（斜边）=√（a²+b²）。（a，b为两直角边）
        return Math.sqrt(Math.pow((tile1.x - tile2[0]), 2) + Math.pow((tile1.y - tile2[1]), 2))
    }

    //创建瓦片id
    createTileKey(xyz: XYZ | number, y?: number, z?: number): string {
        if (xyz instanceof Object) {
            return `${xyz.z}/${xyz.x}/${xyz.y}`;
        } else {
            const x = xyz;
            return `${z}/${x}/${y}`;
        }
    }

    deepFormatTileNumber(num: number, maxNum: number){
        if(num>=0 && num<maxNum){
            return num;
        }
        if(num>0 && num >= maxNum){
            num = num - maxNum;
        }else if(num < 0){
            num = num + maxNum;
        }
        return this.deepFormatTileNumber(num, maxNum);
    }

    //创建瓦片
    createTile(gl, xyz: XYZ) {
        let zoom = Math.ceil(this.map.getZoom());
        if(zoom > (this.options.tileMaxZoom as number)){
            zoom = this.options.tileMaxZoom as number;
        }
        const maxTileNumber = Math.pow(2, zoom);
        let x = xyz.x;
        let y = xyz.y;
        x = this.deepFormatTileNumber(x, maxTileNumber);
        y = this.deepFormatTileNumber(y, maxTileNumber);
        const templateData = {
            x,
            y,
            z: xyz.z
        }
        if (this.options.subdomains) {
            templateData['s'] = this.options.subdomains[Math.abs(xyz.x + xyz.y) % this.options.subdomains.length]
        }
        //替换请求地址中的变量
        const _url = template(this.options.url, templateData);

        const tile: TileType = {
            xyz,
            xyzKey: this.createTileKey(xyz),
            isLoad: false,
            url: _url,
            imageCanceled: false
        };

        //瓦片编号转经纬度，并进行偏移
        let leftTop: ResultLngLat, rightTop: ResultLngLat, leftBottom: ResultLngLat, rightBottom: ResultLngLat;
        if (this.options.tileType === 'xyz') {
            leftTop = this.gridCache[this.createTileKey(xyz)]
            rightTop = this.gridCache[this.createTileKey(xyz.x + 1, xyz.y, xyz.z)]
            leftBottom = this.gridCache[this.createTileKey(xyz.x, xyz.y + 1, xyz.z)]
            rightBottom = this.gridCache[this.createTileKey(xyz.x + 1, xyz.y + 1, xyz.z)]
        } else {
            leftTop = this.gridCache[this.createTileKey(xyz.x, xyz.y + 1, xyz.z)]
            rightTop = this.gridCache[this.createTileKey(xyz.x + 1, xyz.y + 1, xyz.z)]
            leftBottom = this.gridCache[this.createTileKey(xyz)]
            rightBottom = this.gridCache[this.createTileKey(xyz.x + 1, xyz.y, xyz.z)]
        }

        //顶点坐标+纹理坐标
        const attrData = new Float32Array([
                leftTop.lng, leftTop.lat, 0.0, 1.0,
                leftBottom.lng, leftBottom.lat, 0.0, 0.0,
                rightTop.lng, rightTop.lat, 1.0, 1.0,
                rightBottom.lng, rightBottom.lat, 1.0, 0.0
        ])
        // console.log('attrData: ', attrData)
        // var attrData = new Float32Array([
        //     116.38967958133532, 39.90811009556515, 0.0, 1.0,
        //     116.38967958133532, 39.90294980726742, 0.0, 0.0,
        //     116.39486013141436, 39.90811009556515, 1.0, 1.0,
        //     116.39486013141436, 39.90294980726742, 1.0, 0.0
        // ])
        const FSIZE = attrData.BYTES_PER_ELEMENT;

        //创建缓冲区并传入数据
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, attrData, gl.STATIC_DRAW);
        tile.buffer = buffer;
        //从缓冲区中获取顶点数据的参数
        tile.PosParam = {
            size: 2,
            stride: FSIZE * 4,
            offset: 0
        }
        //从缓冲区中获取纹理数据的参数
        tile.TextCoordParam = {
            size: 2,
            stride: FSIZE * 4,
            offset: FSIZE * 2
        }

        //加载瓦片
        const img = new Image(256, 256);
        img.onload = () => {
            // 创建纹理对象
            tile.texture = gl.createTexture();
            //向target绑定纹理对象
            gl.bindTexture(gl.TEXTURE_2D, tile.texture);
            //对纹理进行Y轴反转
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);

            if(this.options.debug){
                // 测试瓦片编号
                const canvas = document.createElement('canvas');
                canvas.width = 256;
                canvas.height = 256;
                const cxt = canvas.getContext('2d') as CanvasRenderingContext2D;
                cxt.drawImage(img,0,0)
                cxt.font = "25px Verdana";
                cxt.fillStyle = "#ff0000";
                cxt.strokeStyle = "#FF0000";
                cxt.strokeRect(0, 0, 256, 256);
                cxt.fillText(`(${  [xyz.x, xyz.y, xyz.z].join(',')  })`, 10, 30);
                //配置纹理图像
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
            }else{
                //配置纹理图像
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            }

            tile.isLoad = true;
            if(this.showTiles.findIndex(item => item === tile) >= 0){
                this.requestRender()  //主动让地图重绘
            }
        };
        img.onerror = () => {
            if(!tile.imageCanceled){
                tile.imageError = true
            }
        }
        img.crossOrigin = 'anonymous';
        img.src = _url;
        tile.image = img;
        return tile;
    }

    // 设置位置的顶点参数
    //参考：https://github.com/xiaoiver/custom-mapbox-layer/blob/master/src/layers/PointCloudLayer2.ts
    setVertex(gl, program: any) {
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "u_ProjectionMatrix"), false, this._projectionMatrix.toArray());
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "u_ViewMatrix4"), false, this._viewMatrix4.toArray());
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "u_MvpMatrix4"), false, this._mvpMatrix4.toArray());
        gl.uniform1f(gl.getUniformLocation(program, "u_isOrtho"), this.isOrtho);
    }
    requestRender(){
        if(this.map){
            this.map.getContext().setDirty()
            this.map.render();
        }
    }

    show(){
        this.isLayerShow = true;
        this.update();
        this.layer.show()
    }

    hide() {
        this.isLayerShow = false;
        this.layer.hide()
    }

    getzIndex(): number{
        return this.layer.getzIndex();
    }

    setzIndex(zIndex: number){
        this.options.zIndex = zIndex;
        this.layer.setzIndex(zIndex)
    }

    getOpacity(): number {
        return this.layer.getOpacity()
    }

    setOpacity(opacity: number){
        this.options.opacity = opacity;
        this.layer.setOpacity(opacity);
    }

    getZooms(): [number, number]{
        return this.layer.getZooms()
    }

    setZooms(zooms: [number, number]){
        this.options.zooms = zooms;
        this.layer.setZooms(zooms)
    }

    setMask(mask?: MaskType) {
        this._destroyMaskCache();
        this._createMask(mask);
        this.options.mask = mask;
        this.requestRender();
    }

    getMask() {
        return this.options.mask;
    }

    getMap(){
        return this.map;
    }

    _destroyMaskCache(){
        this.maskCache.forEach(item => {
            this.gl.deleteBuffer(item.vertexBuffer);
            this.gl.deleteBuffer(item.indexBuffer);
        })
        this.maskCache = [];
    }

    _destroyTile(tile: TileType){
        if(tile.buffer){
            this.gl.deleteBuffer(tile.buffer);
        }
        if(tile.texture){
            this.gl.deleteTexture(tile.texture);
        }
    }

    _clearAllCacheTile() {
        this.tileCache.forEach(tile => {
            this._destroyTile(tile);
        })
        this.tileCache = [];
    }

    _clearShowTile() {
        this.showTiles.forEach(item => {
            if(this.tileCache.findIndex(cache => cache.xyzKey === item.xyzKey) < 0){
                this._destroyTile(item);
            }
        });
        this.showTiles = [];
    }

    destroy() {
        this.isLayerShow = false;
        this.map.remove(this.layer);
        this.map.off('dragging', this.mapCallback);
        this.map.off('moveend', this.mapCallback)
        this.map.off('zoomchange', this.mapCallback);
        this.map.off('rotatechange', this.mapCallback);
        this._destroyMaskCache();
        this._clearShowTile();
        this._clearAllCacheTile();
        this.gridCache = {};
        this.transformBaidu = null as any;
        this.mapCallback = null;
        this.gl.deleteProgram(this.program);
        this.gl.deleteProgram(this.maskProgram);
        this.program = null;
        this.maskProgram = null;
        this.options = undefined as any;
        this.customCoords = undefined;
        this.center = undefined;
        this.layer = null;
        this.gl = null;
        this.map = null;
    }
}

export {CustomXyzLayer}
