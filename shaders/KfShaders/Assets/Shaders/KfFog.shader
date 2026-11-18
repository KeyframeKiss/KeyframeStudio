// Two-tone distance fog: near colour → far colour, thinning with height. Uses the camera's depth texture.
Shader "Hidden/KeyframeStudio/Fog"
{
    Properties
    {
        _MainTex ("", 2D) = "white" {}
    }
    SubShader
    {
        ZTest Always Cull Off ZWrite Off
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "KfCommon.cginc"

            sampler2D_float _CameraDepthTexture;
            float4x4 _KfInvProj;      // camera.projectionMatrix.inverse
            float4x4 _KfCamToWorld;   // camera.cameraToWorldMatrix
            float4 _KfColorNear;      // rgb + strength
            float4 _KfColorFar;
            float4 _KfFog;            // x density, y start distance, z split (0..1 of the way into the fog), w softness
            float4 _KfHeight;         // x base height, y falloff (0 = none), z fog the sky (0/1), w far distance

            fixed4 frag(v2f i) : SV_Target
            {
                fixed4 src = tex2D(_MainTex, i.uv);
                float raw = SAMPLE_DEPTH_TEXTURE(_CameraDepthTexture, i.uvDepth);
                float d01 = Linear01Depth(raw);
                bool sky = d01 > 0.9999;
                if (sky && _KfHeight.z < 0.5) return src;

                // view ray to the far plane, scaled by depth → view-space position → world
                float4 farView = mul(_KfInvProj, float4(i.uvDepth * 2 - 1, 1, 1));
                float3 viewPos = (farView.xyz / farView.w) * (sky ? min(1, _KfHeight.w / _ProjectionParams.z) : d01);
                float3 worldPos = mul(_KfCamToWorld, float4(viewPos, 1)).xyz;
                float dist = length(viewPos);

                float d = max(0, dist - _KfFog.y);
                float amount = 1 - exp(-_KfFog.x * d);
                // thinner higher up
                if (_KfHeight.y > 0) amount *= saturate(exp(-_KfHeight.y * max(0, worldPos.y - _KfHeight.x)));

                // where the near colour turns into the far one
                float t = smoothstep(_KfFog.z - _KfFog.w, _KfFog.z + _KfFog.w + 1e-4, amount);
                float4 col = lerp(_KfColorNear, _KfColorFar, t);
                return fixed4(lerp(src.rgb, col.rgb, saturate(amount * col.a)), src.a);
            }
            ENDCG
        }
    }
    Fallback Off
}
