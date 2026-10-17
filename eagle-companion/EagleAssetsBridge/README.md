# EagleAssets 改名服务

Eagle 的旧 HTTP API 没有提供素材名称修改字段。本服务使用官方 `eagle.item.getById()`、`item.name`、`await item.save()` 保存名称，供 ComfyUI-EagleAssets 查看窗口调用。

安装一次：在支持插件的 Eagle 中打开插件菜单，进入开发者选项，选择“导入本地项目”，选择本文件夹。作为后台服务，它会随 Eagle 启动；首次安装后如未启动，可在插件列表中打开一次。窗口出现“服务已运行”后即可使用 ComfyUI 的改名功能。

本服务仅监听本机随机端口，随机连接凭据保存在当前系统用户的 EagleAssetsBridge/connection.json 中。ComfyUI 后端与 Eagle 应运行在同一台电脑、同一个系统用户下。每次修改都会核对当前素材库；不会直接写 Eagle 的 metadata.json。

官方接口：[项目修改](https://developer.eagle.cool/plugin-api/api/item)、[后台服务](https://developer.eagle.cool/plugin-api/get-started/plugin-types/service)。
