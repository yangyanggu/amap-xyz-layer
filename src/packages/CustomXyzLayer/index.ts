import WebMercatorViewport from 'viewport-mercator-project';
import * as mat4 from 'gl-matrix/mat4';
import * as vec4 from 'gl-matrix/vec4';
import {
    lonLatToTileNumbers, tileNumbersToLonLat,
    gcj02_To_gps84, gps84_To_gcj02,
    gcj02_To_bd09, bd09_To_gcj02, ResultLngLat
} from '../support/coordConver.js'
import TransformClassBaidu from '../support/transform-class-baidu'
import {template} from '../support/Util.js'
import {getDistanceScales, zoomToScale} from '../support/web-mercator.js';

interface CustomGlLayerOptions {
    zooms?: [number, number]
    opacity?: number
    visible?: boolean
    zIndex?: number
}

export interface XyzLayerOptions extends CustomGlLayerOptions {
    url: string
    subdomains?: string[]
    tileType?: 'xyz' | 'bd09'
    proj?: 'wgs84' | 'gcj02' | 'bd09'
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
    buffer?: WebGLBuffer
    PosParam?: PosParamType
    TextCoordParam?: PosParamType
    texture?: WebGLTexture
    isLoad: boolean
}

class CustomXyzLayer {
    options: XyzLayerOptions
    map: any // 地图对象
    layer: any
    customCoords: any
    center: any

    //着色器程序
    program = null as any;
    //存放当前显示的瓦片
    showTiles: TileType[] = [];

    //记录当前图层是否在显示
    isLayerShow = false;

    //存放所有加载过的瓦片
    tileCache = {};

    //存放瓦片号对应的经纬度
    gridCache: Record<string, ResultLngLat> = {}

    //记录渲染时的变换矩阵。
    //如果瓦片因为网速慢，在渲染完成后才加载过来，可以使用这个矩阵主动更新渲染
    matrix = null as any;

    transformBaidu = new TransformClassBaidu()

    a_Pos: GLint | undefined;
    a_TextCoord: GLint | undefined

    constructor(map: any, options: XyzLayerOptions) {
        if (!map) {
            throw new Error('请传入地图实例')
        }
        this.validate(options);
        this.map = map
        this.center = map.getCenter().toArray();
        this.options = Object.assign(this.getDefaultGlLayerOptions(), options)
        this.customCoords = map.customCoords;
        // 数据使用转换工具进行转换，这个操作必须要提前执行（在获取镜头参数 函数之前执行），否则将会获得一个错误信息。
        this.customCoords.lngLatsToCoords([
            map.getCenter().toArray()
        ]);
        //着色器程序
        this.program;

        //记录当前图层是否在显示
        this.isLayerShow;

        this.layer = new AMap.GLCustomLayer({
            // 图层的层级
            zooms: this.options.zooms,
            opacity: this.options.opacity,
            visible: this.options.visible,
            zIndex: this.options.zIndex,
            // 初始化的操作，创建图层过程中执行一次。
            init: (gl) => {
                const vertexSource = "" +
                    "uniform mat4 u_matrix;" +
                    "attribute vec2 a_pos;" +
                    "attribute vec2 a_TextCoord;" +
                    "varying vec2 v_TextCoord;" +

                    "const float TILE_SIZE = 512.0;" +
                    "const float PI = 3.1415926536;" +
                    "const float WORLD_SCALE = TILE_SIZE / (PI * 2.0);" +

                    "uniform float u_project_scale;" +
                    "uniform bool u_is_offset;" +
                    "uniform vec3 u_pixels_per_degree;" +
                    "uniform vec3 u_pixels_per_degree2;" +
                    "uniform vec3 u_pixels_per_meter;" +
                    "uniform vec2 u_viewport_center;" +
                    "uniform vec4 u_viewport_center_projection;" +
                    "uniform vec2 u_viewport_size;" +
                    "float project_scale(float meters) {" +
                    "    return meters * u_pixels_per_meter.z;" +
                    "}" +
                    "vec3 project_scale(vec3 position) {" +
                    "    return position * u_pixels_per_meter;" +
                    "}" +
                    "vec2 project_mercator(vec2 lnglat) {" +
                    "    float x = lnglat.x;" +
                    "    return vec2(" +
                    "    radians(x) + PI, PI - log(tan(PI * 0.25 + radians(lnglat.y) * 0.5))" +
                    "    );" +
                    "}" +
                    "vec4 project_offset(vec4 offset) {" +
                    "    float dy = offset.y;" +
                    "    dy = clamp(dy, -1., 1.);" +
                    "    vec3 pixels_per_unit = u_pixels_per_degree + u_pixels_per_degree2 * dy;" +
                    "    return vec4(offset.xyz * pixels_per_unit, offset.w);" +
                    "}" +
                    "vec4 project_position(vec4 position) {" +
                    "    if (u_is_offset) {" +
                    "        float X = position.x - u_viewport_center.x;" +
                    "        float Y = position.y - u_viewport_center.y;" +
                    "        return project_offset(vec4(X, Y, position.z, position.w));" +
                    "    }" +
                    "    else {" +
                    "        return vec4(" +
                    "        project_mercator(position.xy) * WORLD_SCALE * u_project_scale, project_scale(position.z), position.w" +
                    "        );" +
                    "    }" +
                    "}" +
                    "vec4 project_to_clipping_space(vec3 position) {" +
                    "    vec4 project_pos = project_position(vec4(position, 1.0));" +
                    "    return u_matrix * project_pos + u_viewport_center_projection;" +
                    "}" +

                    "void main() {" +
                    "   vec4 project_pos = project_position(vec4(a_pos, 0.0, 1.0));" +
                    "   gl_Position = u_matrix * project_pos + u_viewport_center_projection;" +
                    "   v_TextCoord = a_TextCoord;" +
                    "}";

                const fragmentSource = "" +
                    "precision mediump float;" +
                    "uniform sampler2D u_Sampler; " +
                    "varying vec2 v_TextCoord; " +
                    "void main() {" +
                    "   gl_FragColor = texture2D(u_Sampler, v_TextCoord);" +
                    // "    gl_FragColor = vec4(1.0, 0.0, 0.0, 0.5);" +
                    "}";

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
                this.isLayerShow = true;
                map.on('dragging', () => {
                    if (this.isLayerShow) {
                        this.update(gl)
                    }
                })
                map.on('zoomchange', () => {
                    if (this.isLayerShow) {
                        this.update(gl)
                    }
                })
                map.on('rotatechange', () => {
                    if (this.isLayerShow) {
                        this.update(gl)
                    }
                })
                this.update(gl)
            },
            render: (gl, state) => {
                console.log('state:P ', state)
                const zooms = this.options.zooms as [number, number];
                if (this.map.getZoom() < zooms[0] || this.map.getZoom() > zooms[1]) return

                //记录变换矩阵，用于瓦片加载后主动绘制
                // this.matrix = state.viewState.modelMatrix;
                this.matrix = state.viewState.mvpMatrix;
                //应用着色程序
                //必须写到这里，不能写到onAdd中，不然gl中的着色程序可能不是上面写的，会导致下面的变量获取不到
                gl.useProgram(this.program);

                for (const tile of this.showTiles) {
                    if (!tile.isLoad) continue;

                    //向target绑定纹理对象
                    gl.bindTexture(gl.TEXTURE_2D, tile.texture);
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


                    gl.bindBuffer(gl.ARRAY_BUFFER, tile.buffer);
                    //设置从缓冲区获取顶点数据的规则
                    gl.vertexAttribPointer(this.a_Pos, tile.PosParam?.size, gl.FLOAT, false, tile.PosParam?.stride, tile.PosParam?.offset);
                    gl.vertexAttribPointer(this.a_TextCoord, tile.TextCoordParam?.size, gl.FLOAT, false, tile.TextCoordParam?.stride, tile.TextCoordParam?.offset);
                    //激活顶点数据缓冲区
                    gl.enableVertexAttribArray(this.a_Pos);
                    gl.enableVertexAttribArray(this.a_TextCoord);

                    // 设置位置的顶点参数
                    this.setVertex(gl)

                    //开启阿尔法混合，实现注记半透明效果
                    gl.enable(gl.BLEND);
                    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

                    //绘制图形
                    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                }
            },
        });
        map.add(this.layer);
    }

    validate(options: XyzLayerOptions) {
        if (!options.url) {
            throw new Error('请传入url');
        }
        if (options.url.includes('{s}') && (!options.subdomains || options.subdomains.length === 0)) {
            throw new Error('请传入subdomains');
        }
    }

    convertLngLat(lnglat) {
        this.customCoords.setCenter(this.center)
        const data = this.customCoords.lngLatsToCoords([
            lnglat
        ]);
        return data[0];
    }

    getDefaultGlLayerOptions(): XyzLayerOptions {
        return {
            url: '',
            zooms: [2, 18],
            opacity: 1,
            visible: true,
            zIndex: 120,
            proj: 'gcj02',
            tileType: 'xyz'
        }
    }

    update(gl) {
        const map = this.map;
        const center = map.getCenter();
        let zoom = Math.ceil(map.getZoom());
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
        else if (this.options.tileType === 'bd09') {
            centerTile = this.transformBaidu.lnglatToTile(center.getLng(), center.getLat(), zoom)
        }
        currentTiles.sort((a, b) => {
            return this.tileDistance(a, centerTile) - this.tileDistance(b, centerTile);
        });

        //加载瓦片
        this.showTiles = [];
        for (const xyz of currentTiles) {
            //走缓存或新加载
            if (this.tileCache[this.createTileKey(xyz)]) {
                this.showTiles.push(this.tileCache[this.createTileKey(xyz)])
            } else {
                const tile = this.createTile(gl, xyz)
                this.showTiles.push(tile);
                this.tileCache[this.createTileKey(xyz)] = tile;
            }
        }
    }

    //缓存瓦片号对应的经纬度
    addGridCache(xyz: XYZ, xPlus: number, yPlus: number) {
        const key = this.createTileKey(xyz.x + xPlus, xyz.y + yPlus, xyz.z)
        if (!this.gridCache[key]) {
            if (this.options.proj === 'wgs84') {
                this.gridCache[key] = gps84_To_gcj02(...tileNumbersToLonLat(xyz.x + xPlus, xyz.y + yPlus, xyz.z))
            } else if (this.options.tileType === 'bd09') {
                this.gridCache[key] = bd09_To_gcj02(...this.transformBaidu.pixelToLnglat(0, 0, xyz.x + xPlus, xyz.y + yPlus, xyz.z))
            } else {
                const lnglat = tileNumbersToLonLat(xyz.x + xPlus, xyz.y + yPlus, xyz.z);
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

    //创建瓦片
    createTile(gl, xyz) {
        const templateData = {
            x: xyz.x,
            y: xyz.y,
            z: xyz.z
        }
        if (this.options.subdomains) {
            templateData['s'] = this.options.subdomains[Math.abs(xyz.x + xyz.y) % this.options.subdomains.length]
        }
        //替换请求地址中的变量
        const _url = template(this.options.url, templateData);

        const tile: TileType = {
            xyz,
            isLoad: false
        };


        //瓦片编号转经纬度，并进行偏移
        let leftTop, rightTop, leftBottom, rightBottom;
        if (this.options.tileType === 'xyz') {
            leftTop = this.gridCache[this.createTileKey(xyz)]
            rightTop = this.gridCache[this.createTileKey(xyz.x + 1, xyz.y, xyz.z)]
            leftBottom = this.gridCache[this.createTileKey(xyz.x, xyz.y + 1, xyz.z)]
            rightBottom = this.gridCache[this.createTileKey(xyz.x + 1, xyz.y + 1, xyz.z)]
        } else if (this.options.tileType === 'bd09') {
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
        const img = new Image();
        img.onload = () => {
            // 创建纹理对象
            tile.texture = gl.createTexture();
            //向target绑定纹理对象
            gl.bindTexture(gl.TEXTURE_2D, tile.texture);
            //对纹理进行Y轴反转
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
            //配置纹理图像
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

            tile.isLoad = true;

            this.map.render()  //主动让地图重绘
        };
        img.crossOrigin = 'anonymous';
        img.src = _url;

        return tile;
    }

    // 设置位置的顶点参数
    //参考：https://github.com/xiaoiver/custom-mapbox-layer/blob/master/src/layers/PointCloudLayer2.ts
    setVertex(gl) {
        const currentZoomLevel = this.map.getZoom();
        const bearing = this.map.getRotation();
        const pitch = this.map.getPitch();
        const center = this.map.getCenter();

        const viewport = new WebMercatorViewport({
            // width: gl.drawingBufferWidth*1.11,
            // height: gl.drawingBufferHeight*1.11,
            width: gl.drawingBufferWidth,
            height: gl.drawingBufferHeight,

            longitude: center.lng,
            latitude: center.lat,
            zoom: currentZoomLevel,
            pitch,
            bearing,
        });

        const {viewProjectionMatrix, projectionMatrix, viewMatrix, viewMatrixUncentered} = viewport;

        const drawParams = {
            'u_matrix': viewProjectionMatrix,
            'u_point_size': undefined,
            'u_is_offset': false,
            'u_pixels_per_degree': [0, 0, 0],
            'u_pixels_per_degree2': [0, 0, 0],
            'u_viewport_center': [0, 0],
            'u_pixels_per_meter': [0, 0, 0],
            'u_project_scale': zoomToScale(currentZoomLevel),
            'u_viewport_center_projection': [0, 0, 0, 0],
        };

        if (currentZoomLevel > 12) {
            const {pixelsPerDegree, pixelsPerDegree2} = getDistanceScales({
                longitude: center.lng,
                latitude: center.lat,
                zoom: currentZoomLevel,
                highPrecision: true
            });

            const positionPixels = viewport.projectFlat(
                [Math.fround(center.lng), Math.fround(center.lat)],
                Math.pow(2, currentZoomLevel)
            );

            const projectionCenter = vec4.transformMat4(
                [],
                [positionPixels[0], positionPixels[1], 0.0, 1.0],
                viewProjectionMatrix
            );

            // Always apply uncentered projection matrix if available (shader adds center)
            const viewMatrix2 = viewMatrixUncentered || viewMatrix;

            // Zero out 4th coordinate ("after" model matrix) - avoids further translations
            // viewMatrix = new Matrix4(viewMatrixUncentered || viewMatrix)
            //   .multiplyRight(VECTOR_TO_POINT_MATRIX);
            let viewProjectionMatrix2 = mat4.multiply([], projectionMatrix, viewMatrix2);
            const VECTOR_TO_POINT_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
            viewProjectionMatrix2 = mat4.multiply([], viewProjectionMatrix2, VECTOR_TO_POINT_MATRIX);

            drawParams['u_matrix'] = viewProjectionMatrix2;
            drawParams['u_is_offset'] = true;
            drawParams['u_viewport_center'] = [Math.fround(center.lng), Math.fround(center.lat)];
            drawParams['u_viewport_center_projection'] = projectionCenter;
            drawParams['u_pixels_per_degree'] = pixelsPerDegree && pixelsPerDegree.map(p => Math.fround(p));
            drawParams['u_pixels_per_degree2'] = pixelsPerDegree2 && pixelsPerDegree2.map(p => Math.fround(p));
        }


        gl.uniformMatrix4fv(gl.getUniformLocation(this.program, "u_matrix"), false, drawParams['u_matrix']);

        gl.uniform1f(gl.getUniformLocation(this.program, "u_project_scale"), drawParams['u_project_scale']);
        gl.uniform1i(gl.getUniformLocation(this.program, "u_is_offset"), drawParams['u_is_offset'] ? 1 : 0);
        gl.uniform3fv(gl.getUniformLocation(this.program, "u_pixels_per_degree"), drawParams['u_pixels_per_degree']);
        gl.uniform3fv(gl.getUniformLocation(this.program, "u_pixels_per_degree2"), drawParams['u_pixels_per_degree2']);
        gl.uniform3fv(gl.getUniformLocation(this.program, "u_pixels_per_meter"), drawParams['u_pixels_per_meter']);
        gl.uniform2fv(gl.getUniformLocation(this.program, "u_viewport_center"), drawParams['u_viewport_center']);
        gl.uniform4fv(gl.getUniformLocation(this.program, "u_viewport_center_projection"), drawParams['u_viewport_center_projection']);

    }

    show(){
        this.layer.show()
    }

    hide() {
        this.layer.hide()
    }

    destroy() {
        this.isLayerShow = false;
        this.map = null
    }
}

export {CustomXyzLayer}
